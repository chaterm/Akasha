import {
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeyRepo } from '@akasha/db/repos/api-key/api-key.repo';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { WorkspaceRepo } from '@akasha/db/repos/workspace/workspace.repo';
import { SpaceRepo } from '@akasha/db/repos/space/space.repo';
import { User, Workspace } from '@akasha/db/types/entity.types';
import { TokenService } from '../auth/services/token.service';
import { JwtApiKeyPayload, JwtType } from '../auth/dto/jwt-payload';
import {
  extractBearerTokenFromHeader,
  isUserDisabled,
} from '../../common/helpers';
import {
  getApiKeyAccess,
  isAgentApiKeyAccess,
  withApiKeyAccess,
} from '../../common/auth/api-key-access';
import type { AgentAccessContext } from '../../common/auth/agent-access-context';
import { ApiKeyType } from '../../common/auth/api-key-type';
import { UserType } from '../../common/auth/user-type';
import { FastifyRequest } from 'fastify';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { ModuleRef } from '@nestjs/core';

export type McpAuthContext = {
  user: User;
  workspace: Workspace;
  agentAccess?: AgentAccessContext;
};

@Injectable()
export class McpAuthService {
  private readonly logger = new Logger(McpAuthService.name);

  constructor(
    private readonly apiKeyRepo: ApiKeyRepo,
    private readonly tokenService: TokenService,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly spaceRepo: SpaceRepo,
    @Optional() private readonly environmentService?: EnvironmentService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  async authenticate(request: FastifyRequest): Promise<McpAuthContext> {
    const publicKeyHeader = request.headers['x-akasha-public-key'];
    const publicKey = Array.isArray(publicKeyHeader)
      ? publicKeyHeader[0]
      : publicKeyHeader;
    if (typeof publicKey === 'string' && publicKey.trim()) {
      return this.authenticateAgentApiKey(request, publicKey.trim());
    }

    const tokenHeader = request.headers['x-token'];
    const ssoToken = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    if (typeof ssoToken === 'string' && ssoToken.trim()) {
      return this.authenticateSso(request, ssoToken.trim());
    }

    const token = extractBearerTokenFromHeader(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let payload: JwtApiKeyPayload;
    try {
      payload = await this.tokenService.verifyJwt(token, JwtType.API_KEY);
    } catch {
      throw new UnauthorizedException('Invalid API key');
    }

    const requestWorkspaceId = (request.raw as any)?.workspaceId;
    if (requestWorkspaceId && requestWorkspaceId !== payload.workspaceId) {
      throw new UnauthorizedException('Workspace does not match');
    }

    const key = await this.apiKeyRepo.findById(
      payload.apiKeyId,
      payload.workspaceId,
    );
    if (!key) {
      throw new UnauthorizedException('API key not found or revoked');
    }
    const workspace = await this.workspaceRepo.findById(payload.workspaceId);
    if (!workspace) {
      throw new UnauthorizedException('Workspace not found');
    }

    if (key.keyType === ApiKeyType.AGENT) {
      if (
        !key.agentUserId ||
        payload.sub !== key.agentUserId ||
        payload.credentialVersion === undefined ||
        Number(key.credentialVersion) !== payload.credentialVersion
      ) {
        throw new UnauthorizedException('Agent API key is no longer valid');
      }
      const user = await this.userRepo.findById(key.agentUserId, workspace.id);
      if (!user || user.userType !== UserType.AGENT || isUserDisabled(user)) {
        throw new UnauthorizedException('Agent user is unavailable');
      }
      const authenticatedUser = withApiKeyAccess(user, {
        apiKeyId: key.id,
        personalSpaceId: null,
        keyType: ApiKeyType.AGENT,
        credentialVersion: payload.credentialVersion,
      });
      this.trackLastUsed(key.id);
      return {
        user: authenticatedUser,
        workspace,
        agentAccess: {
          apiKeyId: key.id,
          credentialVersion: payload.credentialVersion,
          agentUser: authenticatedUser,
          workspace,
        },
      };
    }

    if (key.expiresAt && key.expiresAt <= new Date()) {
      throw new UnauthorizedException('API key has expired');
    }
    const user = await this.userRepo.findById(payload.sub, workspace.id);
    if (!user || user.userType === UserType.AGENT || isUserDisabled(user)) {
      throw new UnauthorizedException('User not found');
    }
    const personalSpace = await this.spaceRepo.findPersonalSpaceForUser({
      userId: user.id,
      workspaceId: workspace.id,
    });
    const authenticatedUser = withApiKeyAccess(user, {
      apiKeyId: key.id,
      personalSpaceId: personalSpace?.id ?? null,
      keyType: ApiKeyType.PERSONAL,
    });
    this.trackLastUsed(key.id);
    return { user: authenticatedUser, workspace };
  }

  private async authenticateAgentApiKey(
    request: FastifyRequest,
    token: string,
  ): Promise<McpAuthContext> {
    const workspace =
      (request.raw as any)?.workspace ?? (request as any).workspace;
    if (!workspace?.id) {
      throw new UnauthorizedException('Workspace is required');
    }
    const result = await this.getApiKeyService().validatePublicApiKey(
      token,
      workspace.id,
    );
    const access = getApiKeyAccess(result.user);
    if (!isAgentApiKeyAccess(access)) {
      throw new UnauthorizedException('An Agent API key is required');
    }
    return {
      user: result.user,
      workspace: result.workspace,
      agentAccess: {
        apiKeyId: access.apiKeyId,
        credentialVersion: access.credentialVersion,
        agentUser: result.user,
        workspace: result.workspace,
      },
    };
  }

  private getApiKeyService(): {
    validateApiKey: (
      payload: JwtApiKeyPayload,
    ) => Promise<{ user: User; workspace: Workspace }>;
    validatePublicApiKey: (
      token: string,
      workspaceId: string,
    ) => Promise<{ user: User; workspace: Workspace }>;
  } {
    try {
      // Keep the core MCP module independent from the enterprise module.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ApiKeyService } = require('../../features/api-key/api-key.service');
      const service = this.moduleRef?.get(ApiKeyService, { strict: false });
      if (service) return service;
    } catch {
      // Mapped to one stable authentication error below.
    }
    throw new UnauthorizedException('API key authentication is unavailable');
  }

  private trackLastUsed(apiKeyId: string): void {
    this.apiKeyRepo
      .updateLastUsed(apiKeyId)
      .catch((err) =>
        this.logger.warn(
          `Failed to update lastUsedAt for API key ${apiKeyId}: ${err?.message}`,
        ),
      );
  }

  private async authenticateSso(
    request: FastifyRequest,
    token: string,
  ): Promise<McpAuthContext> {
    const workspace =
      (request.raw as any)?.workspace ?? (request as any).workspace;
    const ssoApi = this.environmentService?.getHoidcSsoApi();
    const platformId = this.environmentService?.getHoidcPlatformId();
    if (!workspace?.id || !ssoApi || !platformId) {
      throw new UnauthorizedException('SSO authentication is not configured');
    }

    let hoidcService: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { HoidcService } = require('../../ee/sso/hoidc.service');
      hoidcService = this.moduleRef?.get(HoidcService, { strict: false });
    } catch {
      throw new UnauthorizedException('SSO authentication is unavailable');
    }
    if (!hoidcService) {
      throw new UnauthorizedException('SSO authentication is unavailable');
    }

    const info = await hoidcService.verifyToken(
      {
        ssoApi,
        platformId,
        workspaceId: workspace.id,
        allowSignup: false,
      },
      token,
    );
    const user = await this.userRepo.findByEmail(info.email, workspace.id);
    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException(
        'SSO user is not a member of this workspace',
      );
    }
    return { user, workspace };
  }
}
