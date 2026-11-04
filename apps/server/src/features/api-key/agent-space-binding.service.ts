import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { User, Workspace } from '@akasha/db/types/entity.types';
import { ApiKeyRepo } from '@akasha/db/repos/api-key/api-key.repo';
import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import type { AgentAccessContext } from '../../common/auth/agent-access-context';
import { ApiKeyType } from '../../common/auth/api-key-type';
import { SpaceRole, UserRole } from '../../common/helpers/types/permission';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { ErrorCode, errorBody } from '../../common/errors/error-codes';

@Injectable()
export class AgentSpaceBindingService {
  constructor(
    private readonly apiKeyRepo: ApiKeyRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async getSpaces(input: {
    workspace: Workspace;
    user?: User;
    agentAccess?: AgentAccessContext;
  }) {
    const [manageableSpaces, boundSpaces] = await Promise.all([
      input.user
        ? this.getManageableSpaces(input.user, input.workspace.id)
        : Promise.resolve(null),
      input.agentAccess
        ? this.apiKeyRepo.findBoundSpaces(
            input.agentAccess.apiKeyId,
            input.workspace.id,
          )
        : Promise.resolve(null),
    ]);

    return {
      user: manageableSpaces ? { manageableSpaces } : null,
      agent: boundSpaces ? { boundSpaces } : null,
    };
  }

  async replaceBindings(input: {
    workspace: Workspace;
    agentAccess: AgentAccessContext;
    spaceIds: string[];
  }) {
    const delegatedUser = input.agentAccess.delegatedUser;
    if (!delegatedUser) {
      throw new UnauthorizedException('SSO credential is required');
    }
    const spaceIds = [...new Set(input.spaceIds)];

    const manageableSpaces = await this.getManageableSpaces(
      delegatedUser,
      input.workspace.id,
    );
    const manageableIds = new Set(manageableSpaces.map((space) => space.id));
    if (spaceIds.some((spaceId) => !manageableIds.has(spaceId))) {
      throw new ForbiddenException(
        errorBody(
          ErrorCode.AGENT_SPACE_ADMIN_REQUIRED,
          'The user must be an administrator of every selected space',
        ),
      );
    }

    const result = await this.apiKeyRepo.transaction(async (trx) => {
      const apiKey = await this.apiKeyRepo.findByIdForUpdate(
        input.agentAccess.apiKeyId,
        input.workspace.id,
        trx,
      );
      if (
        !apiKey ||
        apiKey.keyType !== ApiKeyType.AGENT ||
        !apiKey.agentUserId ||
        Number(apiKey.credentialVersion) !== input.agentAccess.credentialVersion
      ) {
        throw new UnauthorizedException('Invalid agent API key');
      }

      const validSpaceIds = await this.apiKeyRepo.findBindableSpaceIds(
        input.workspace.id,
        spaceIds,
        trx,
      );
      if (validSpaceIds.length !== spaceIds.length) {
        throw new BadRequestException('Invalid spaceIds');
      }

      await this.apiKeyRepo.replaceAgentSpaceBindings(
        {
          apiKeyId: apiKey.id,
          agentUserId: apiKey.agentUserId,
          spaceIds,
        },
        trx,
      );

      return {
        boundSpaces: await this.apiKeyRepo.findBoundSpaces(
          apiKey.id,
          input.workspace.id,
          trx,
        ),
      };
    });
    this.auditService.log({
      event: AuditEvent.API_KEY_UPDATED,
      resourceType: AuditResource.API_KEY,
      resourceId: input.agentAccess.apiKeyId,
      metadata: {
        keyType: ApiKeyType.AGENT,
        action: 'replace_spaces',
        spaceIds,
      },
    });
    return result;
  }

  private async getManageableSpaces(user: User, workspaceId: string) {
    const spaces = await this.apiKeyRepo.findBindableSpaces(workspaceId);
    if (user.role === UserRole.OWNER) return spaces;

    const roles = await this.spaceMemberRepo.findUserSpaceRolesForSpaces({
      userId: user.id,
      spaceIds: spaces.map((space) => space.id),
    });
    const manageableIds = new Set(
      roles
        .filter((membership) => membership.role === SpaceRole.ADMIN)
        .map((membership) => membership.spaceId),
    );
    return spaces.filter((space) => manageableIds.has(space.id));
  }
}
