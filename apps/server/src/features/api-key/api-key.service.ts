import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeyRepo } from '@akasha/db/repos/api-key/api-key.repo';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { WorkspaceRepo } from '@akasha/db/repos/workspace/workspace.repo';
import { SpaceRepo } from '@akasha/db/repos/space/space.repo';
import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import type { User, Workspace } from '@akasha/db/types/entity.types';
import { TokenService } from '../../core/auth/services/token.service';
import { JwtApiKeyPayload, JwtType } from '../../core/auth/dto/jwt-payload';
import { UserRole } from '../../common/helpers/types/permission';
import { PaginationOptions } from '@akasha/db/pagination/pagination-options';
import {
  getApiKeyAccess,
  isAgentApiKeyAccess,
  withApiKeyAccess,
} from '../../common/auth/api-key-access';
import { ApiKeyType } from '../../common/auth/api-key-type';
import { UserType } from '../../common/auth/user-type';
import { isUserDisabled } from '../../common/helpers';
import { AgentUserService } from './agent-user.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { ErrorCode, errorBody } from '../../common/errors/error-codes';

@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(
    private readonly apiKeyRepo: ApiKeyRepo,
    private readonly tokenService: TokenService,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly spaceRepo: SpaceRepo,
    private readonly agentUserService: AgentUserService,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async createApiKey(opts: {
    name: string;
    expiresAt?: string;
    creatorId: string;
    workspaceId: string;
  }) {
    const { name, expiresAt, creatorId, workspaceId } = opts;

    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new NotFoundException('Workspace not found');

    const user = await this.userRepo.findById(creatorId, workspaceId);
    if (!user || user.userType === UserType.AGENT) {
      throw new ForbiddenException();
    }

    const workspaceSettings = (workspace.settings ?? {}) as Record<string, any>;
    const restrictToAdmins = workspaceSettings?.api?.restrictToAdmins ?? false;
    if (
      restrictToAdmins &&
      user.role !== UserRole.OWNER &&
      user.role !== UserRole.ADMIN
    ) {
      throw new ForbiddenException(
        errorBody(
          ErrorCode.API_KEY_CREATION_RESTRICTED,
          'API key creation is restricted to admins',
        ),
      );
    }

    const expiresDate = expiresAt ? new Date(expiresAt) : null;
    if (expiresDate && expiresDate <= new Date()) {
      throw new BadRequestException(
        errorBody(
          ErrorCode.API_KEY_EXPIRATION_IN_PAST,
          'Expiration date must be in the future',
        ),
      );
    }

    const apiKey = await this.apiKeyRepo.create({
      name,
      creatorId,
      workspaceId,
      keyType: ApiKeyType.PERSONAL,
      expiresAt: expiresDate,
      agentUserId: null,
      credentialVersion: null,
    });

    const expiresIn = expiresDate
      ? Math.floor((expiresDate.getTime() - Date.now()) / 1000)
      : undefined;
    const token = await this.tokenService.generateApiToken({
      apiKeyId: apiKey.id,
      user,
      workspaceId,
      expiresIn,
    });

    return {
      ...apiKey,
      token,
      creator: { id: user.id, name: user.name, email: user.email },
    };
  }

  async getUserApiKeys(
    creatorId: string,
    workspaceId: string,
    pagination: PaginationOptions,
  ) {
    return this.apiKeyRepo.findUserKeys(creatorId, workspaceId, pagination);
  }

  async getWorkspaceApiKeys(
    workspaceId: string,
    pagination: PaginationOptions,
  ) {
    return this.apiKeyRepo.findWorkspaceKeys(workspaceId, pagination);
  }

  async createPublicApiKey(opts: {
    name: string;
    creatorId: string;
    workspaceId: string;
  }) {
    const owner = await this.requireWorkspaceOwner(
      opts.creatorId,
      opts.workspaceId,
    );
    return this.provisionAgentApiKey({
      name: opts.name,
      owner,
      workspaceId: opts.workspaceId,
    });
  }

  /**
   * Platform-to-platform agent API-key provisioning. There is no logged-in
   * user, so the created key is attributed to the workspace owner. `agentId` is
   * supplied by the calling platform and forms the stable email identifier of
   * the agent user.
   */
  async createAgentApiKeyForPlatform(opts: {
    agentId: string;
    name: string;
    workspaceId: string;
  }) {
    const agentId = opts.agentId.trim();
    if (!agentId) {
      throw new BadRequestException('agent_id is required');
    }

    const owner = await this.userRepo.findWorkspaceOwner(opts.workspaceId);
    if (!owner) {
      throw new NotFoundException('Workspace owner not found');
    }

    return this.provisionAgentApiKey({
      name: opts.name,
      owner,
      workspaceId: opts.workspaceId,
      agentId,
    });
  }

  private async provisionAgentApiKey(opts: {
    name: string;
    owner: User;
    workspaceId: string;
    agentId?: string;
  }) {
    const { owner, workspaceId, agentId } = opts;
    const name = opts.name.trim();
    if (!name) {
      throw new BadRequestException('Agent API key name is required');
    }

    try {
      const result = await this.apiKeyRepo.transaction(async (trx) => {
        if (await this.apiKeyRepo.findActiveAgentByName(workspaceId, name, trx)) {
          throw new ConflictException(
            errorBody(
              ErrorCode.AGENT_NAME_TAKEN,
              'Agent API key name already exists',
            ),
          );
        }

        const agentUser = await this.agentUserService.create(
          name,
          workspaceId,
          trx,
          agentId,
        );
        const credentialVersion = Date.now();
        const apiKey = await this.apiKeyRepo.create(
          {
            name,
            creatorId: owner.id,
            workspaceId,
            keyType: ApiKeyType.AGENT,
            expiresAt: null,
            agentUserId: agentUser.id,
            credentialVersion,
          },
          trx,
        );
        const token = await this.tokenService.generateApiToken({
          apiKeyId: apiKey.id,
          user: agentUser,
          workspaceId,
          credentialVersion,
        });

        return {
          ...apiKey,
          token,
          spaces: [],
          creator: { id: owner.id, name: owner.name, email: owner.email },
          agentUser,
        };
      });
      this.logAgentKeyChange(AuditEvent.API_KEY_CREATED, result.id, 'create');
      return result;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          errorBody(
            ErrorCode.AGENT_NAME_TAKEN,
            'Agent API key name or agent_id already exists',
          ),
        );
      }
      throw error;
    }
  }

  async getPublicApiKeys(workspaceId: string, pagination: PaginationOptions) {
    return this.apiKeyRepo.findPublicKeys(workspaceId, pagination);
  }

  async getAgentBindableSpaces(userId: string, workspaceId: string) {
    await this.requireWorkspaceOwner(userId, workspaceId);
    return this.apiKeyRepo.findBindableSpaces(workspaceId);
  }

  /**
   * Owner-facing space rebinding from the workspace settings page. Authorized
   * by workspace ownership over a normal login session; the target agent key is
   * named explicitly via `apiKeyId`. The business-facing agent-self flow lives
   * in AgentSpaceBindingService.replaceBindings and is unaffected.
   */
  async updateAgentSpaces(opts: {
    apiKeyId: string;
    userId: string;
    workspaceId: string;
    spaceIds: string[];
  }) {
    await this.requireWorkspaceOwner(opts.userId, opts.workspaceId);
    const spaceIds = [...new Set(opts.spaceIds)];
    const result = await this.apiKeyRepo.transaction(async (trx) => {
      const key = await this.requireAgentKeyForUpdate(
        opts.apiKeyId,
        opts.workspaceId,
        trx,
      );
      const valid = await this.apiKeyRepo.findBindableSpaceIds(
        opts.workspaceId,
        spaceIds,
        trx,
      );
      if (valid.length !== spaceIds.length) {
        throw new BadRequestException('Invalid spaceIds');
      }
      await this.apiKeyRepo.replaceAgentSpaceBindings(
        { apiKeyId: key.id, agentUserId: key.agentUserId!, spaceIds },
        trx,
      );
      return this.apiKeyRepo.findBoundSpaces(key.id, opts.workspaceId, trx);
    });
    this.logAgentKeyChange(
      AuditEvent.API_KEY_UPDATED,
      opts.apiKeyId,
      'replace_spaces',
    );
    return { spaces: result };
  }

  async updatePublicApiKey(opts: {
    apiKeyId: string;
    name: string;
    userId: string;
    workspaceId: string;
  }) {
    await this.requireWorkspaceOwner(opts.userId, opts.workspaceId);
    const name = opts.name.trim();
    if (!name) {
      throw new BadRequestException('Agent API key name is required');
    }

    try {
      const result = await this.apiKeyRepo.transaction(async (trx) => {
        const key = await this.requireAgentKeyForUpdate(
          opts.apiKeyId,
          opts.workspaceId,
          trx,
        );
        const duplicate = await this.apiKeyRepo.findActiveAgentByName(
          opts.workspaceId,
          name,
          trx,
        );
        if (duplicate && duplicate.id !== key.id) {
          throw new ConflictException(
            errorBody(
              ErrorCode.AGENT_NAME_TAKEN,
              'Agent API key name already exists',
            ),
          );
        }

        await this.agentUserService.rename(
          key.agentUserId!,
          opts.workspaceId,
          name,
          trx,
        );
        return this.apiKeyRepo.updateName(
          key.id,
          opts.workspaceId,
          name,
          trx,
        );
      });
      this.logAgentKeyChange(AuditEvent.API_KEY_UPDATED, result.id, 'rename');
      return result;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          errorBody(
            ErrorCode.AGENT_NAME_TAKEN,
            'Agent API key name already exists',
          ),
        );
      }
      throw error;
    }
  }

  async rotatePublicApiKey(opts: {
    apiKeyId: string;
    userId: string;
    workspaceId: string;
  }) {
    await this.requireWorkspaceOwner(opts.userId, opts.workspaceId);

    const result = await this.apiKeyRepo.transaction(async (trx) => {
      const key = await this.requireAgentKeyForUpdate(
        opts.apiKeyId,
        opts.workspaceId,
        trx,
      );
      const agentUser = await this.agentUserService.requireActive(
        key.agentUserId!,
        opts.workspaceId,
        trx,
      );
      const credentialVersion = Math.max(
        Date.now(),
        Number(key.credentialVersion ?? 0) + 1,
      );
      const token = await this.tokenService.generateApiToken({
        apiKeyId: key.id,
        user: agentUser,
        workspaceId: opts.workspaceId,
        credentialVersion,
      });
      const updated = await this.apiKeyRepo.updateCredentialVersion(
        key.id,
        opts.workspaceId,
        credentialVersion,
        trx,
      );

      return { ...updated, token };
    });
    this.logAgentKeyChange(AuditEvent.API_KEY_UPDATED, result.id, 'rotate');
    return result;
  }

  async deletePublicApiKey(opts: {
    apiKeyId: string;
    userId: string;
    workspaceId: string;
  }): Promise<void> {
    await this.requireWorkspaceOwner(opts.userId, opts.workspaceId);

    await this.apiKeyRepo.transaction(async (trx) => {
      const key = await this.requireAgentKeyForUpdate(
        opts.apiKeyId,
        opts.workspaceId,
        trx,
      );
      await this.spaceMemberRepo.removeAllDirectMembershipsForUser(
        key.agentUserId!,
        trx,
      );
      await this.apiKeyRepo.softDelete(key.id, opts.workspaceId, trx);
      await this.agentUserService.softDelete(
        key.agentUserId!,
        opts.workspaceId,
        trx,
      );
    });
    this.logAgentKeyChange(AuditEvent.API_KEY_DELETED, opts.apiKeyId, 'delete');
  }

  async updateApiKey(opts: {
    apiKeyId: string;
    name: string;
    userId: string;
    workspaceId: string;
  }) {
    const { apiKeyId, name, userId, workspaceId } = opts;
    const key = await this.apiKeyRepo.findById(apiKeyId, workspaceId);
    if (!key) throw new NotFoundException('API key not found');

    const user = await this.userRepo.findById(userId, workspaceId);
    if (!user || user.userType === UserType.AGENT) {
      throw new ForbiddenException();
    }
    const isAdmin =
      user.role === UserRole.OWNER || user.role === UserRole.ADMIN;
    if (key.creatorId !== userId && !isAdmin) {
      throw new ForbiddenException();
    }

    return this.apiKeyRepo.updateName(apiKeyId, workspaceId, name);
  }

  async revokeApiKey(opts: {
    apiKeyId: string;
    userId: string;
    workspaceId: string;
  }) {
    const { apiKeyId, userId, workspaceId } = opts;
    const key = await this.apiKeyRepo.findById(apiKeyId, workspaceId);
    if (!key) throw new NotFoundException('API key not found');
    if (key.keyType !== ApiKeyType.PERSONAL) {
      throw new ForbiddenException('Use the Agent API key delete endpoint');
    }

    const user = await this.userRepo.findById(userId, workspaceId);
    if (!user || user.userType === UserType.AGENT) {
      throw new ForbiddenException();
    }
    const isAdmin =
      user.role === UserRole.OWNER || user.role === UserRole.ADMIN;
    if (key.creatorId !== userId && !isAdmin) {
      throw new ForbiddenException();
    }

    await this.apiKeyRepo.softDelete(apiKeyId, workspaceId);
  }

  async validateApiKey(
    payload: JwtApiKeyPayload,
  ): Promise<{ user: User; workspace: Workspace }> {
    const key = await this.apiKeyRepo.findById(
      payload.apiKeyId,
      payload.workspaceId,
    );
    if (!key) throw new UnauthorizedException('API key not found or deleted');

    const workspace = await this.workspaceRepo.findById(payload.workspaceId);
    if (!workspace) throw new UnauthorizedException();

    if (key.keyType === ApiKeyType.PERSONAL) {
      return this.validatePersonalApiKey(payload, key.id, key.expiresAt, workspace);
    }
    if (key.keyType !== ApiKeyType.AGENT) {
      throw new UnauthorizedException('Unsupported API key type');
    }
    if (
      !key.agentUserId ||
      payload.sub !== key.agentUserId ||
      payload.credentialVersion === undefined ||
      Number(key.credentialVersion) !== payload.credentialVersion
    ) {
      throw new UnauthorizedException('Agent API key is no longer valid');
    }

    const user = await this.userRepo.findById(key.agentUserId, workspace.id);
    if (
      !user ||
      user.userType !== UserType.AGENT ||
      isUserDisabled(user)
    ) {
      throw new UnauthorizedException('Agent user is unavailable');
    }

    const authenticatedUser = withApiKeyAccess(user, {
      apiKeyId: key.id,
      personalSpaceId: null,
      keyType: ApiKeyType.AGENT,
      credentialVersion: payload.credentialVersion,
    });
    this.trackLastUsed(key.id);
    return { user: authenticatedUser, workspace };
  }

  async validatePublicApiKey(token: string, workspaceId: string) {
    let payload: JwtApiKeyPayload;
    try {
      payload = await this.tokenService.verifyJwt(token, JwtType.API_KEY);
    } catch {
      throw new UnauthorizedException('Invalid Agent API key');
    }
    if (payload.workspaceId !== workspaceId) {
      throw new UnauthorizedException('API key workspace does not match');
    }

    const result = await this.validateApiKey(payload);
    const access = getApiKeyAccess(result.user);
    if (!isAgentApiKeyAccess(access)) {
      throw new UnauthorizedException('An Agent API key is required');
    }
    const spaceIds = await this.apiKeyRepo.findSpaceIdsByApiKeyId(access.apiKeyId);
    return {
      ...result,
      apiKeyId: access.apiKeyId,
      workspaceId,
      spaceIds,
      payload,
    };
  }

  private async validatePersonalApiKey(
    payload: JwtApiKeyPayload,
    apiKeyId: string,
    expiresAt: Date | null,
    workspace: Workspace,
  ): Promise<{ user: User; workspace: Workspace }> {
    if (expiresAt && expiresAt <= new Date()) {
      throw new UnauthorizedException('API key has expired');
    }
    const user = await this.userRepo.findById(payload.sub, workspace.id);
    if (
      !user ||
      user.userType === UserType.AGENT ||
      isUserDisabled(user)
    ) {
      throw new UnauthorizedException();
    }
    const personalSpace = await this.spaceRepo.findPersonalSpaceForUser({
      userId: user.id,
      workspaceId: workspace.id,
    });
    const authenticatedUser = withApiKeyAccess(user, {
      apiKeyId,
      personalSpaceId: personalSpace?.id ?? null,
      keyType: ApiKeyType.PERSONAL,
    });
    this.trackLastUsed(apiKeyId);
    return { user: authenticatedUser, workspace };
  }

  private async requireWorkspaceOwner(userId: string, workspaceId: string) {
    const user = await this.userRepo.findById(userId, workspaceId);
    if (
      !user ||
      user.userType === UserType.AGENT ||
      user.role !== UserRole.OWNER ||
      isUserDisabled(user)
    ) {
      throw new ForbiddenException('Workspace owner access required');
    }
    return user;
  }

  private async requireAgentKeyForUpdate(
    apiKeyId: string,
    workspaceId: string,
    trx: Parameters<Parameters<ApiKeyRepo['transaction']>[0]>[0],
  ) {
    const key = await this.apiKeyRepo.findByIdForUpdate(
      apiKeyId,
      workspaceId,
      trx,
    );
    if (!key || key.keyType !== ApiKeyType.AGENT || !key.agentUserId) {
      throw new NotFoundException('Agent API key not found');
    }
    return key;
  }

  private trackLastUsed(apiKeyId: string) {
    this.apiKeyRepo.updateLastUsed(apiKeyId).catch((error) =>
      this.logger.warn(
        `Failed to update lastUsedAt for API key ${apiKeyId}: ${error?.message}`,
      ),
    );
  }

  private logAgentKeyChange(
    event: (typeof AuditEvent)[keyof typeof AuditEvent],
    apiKeyId: string,
    action: string,
  ): void {
    this.auditService.log({
      event,
      resourceType: AuditResource.API_KEY,
      resourceId: apiKeyId,
      metadata: { keyType: ApiKeyType.AGENT, action },
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}
