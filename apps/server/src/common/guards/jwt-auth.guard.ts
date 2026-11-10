import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ModuleRef, Reflector } from '@nestjs/core';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { addDays } from 'date-fns';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { FastifyRequest } from 'fastify';
import { extractBearerTokenFromHeader, isUserDisabled } from '../helpers';
import { AUTH_CREDENTIAL_POLICY } from '../decorators/auth-credentials.decorator';
import { AuthCredentialPolicy } from '../auth/auth-credential-policy';
import { AGENT_CAPABILITY } from '../decorators/agent-callable.decorator';
import {
  getAgentAccessContext,
  setAgentAccessContext,
} from '../auth/agent-access-context';
import { getApiKeyAccess, isAgentApiKeyAccess } from '../auth/api-key-access';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    private environmentService: EnvironmentService,
    private readonly moduleRef: ModuleRef,
    private readonly userRepo: UserRepo,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reflectedPolicy =
      this.reflector.getAllAndOverride<AuthCredentialPolicy>(
        AUTH_CREDENTIAL_POLICY,
        [context.getHandler(), context.getClass()],
      );
    const policy = Object.values(AuthCredentialPolicy).includes(reflectedPolicy)
      ? reflectedPolicy
      : AuthCredentialPolicy.DEFAULT;
    const tokenHeader = request.headers['x-token'];
    const rawSsoToken = Array.isArray(tokenHeader)
      ? tokenHeader[0]
      : tokenHeader;
    const ssoToken =
      typeof rawSsoToken === 'string' && rawSsoToken.trim()
        ? rawSsoToken.trim()
        : undefined;
    const publicKeyHeader = request.headers['x-akasha-public-key'];
    const rawPublicKey = Array.isArray(publicKeyHeader)
      ? publicKeyHeader[0]
      : publicKeyHeader;
    const publicKey =
      typeof rawPublicKey === 'string' && rawPublicKey.trim()
        ? rawPublicKey.trim()
        : undefined;
    const bearerToken = extractBearerTokenFromHeader(request);
    const agentHeader = request.headers['x-iself-agent'];
    const isAgentRequest =
      (Array.isArray(agentHeader) ? agentHeader[0] : agentHeader)?.trim() ===
      '1';

    let agentAuthenticated = false;
    let ssoAuthenticated = false;

    if (publicKey) {
      await this.authenticateAgentApiKey(request, publicKey);
      agentAuthenticated = true;
    } else if (policy === AuthCredentialPolicy.DEFAULT && ssoToken) {
      // Preserve the existing default-route behavior: X-Token is the primary
      // credential unless an explicit public-key header was provided.
      await this.authenticateSso(request, ssoToken, isAgentRequest);
      ssoAuthenticated = true;
    } else if (bearerToken || !ssoToken) {
      await (super.canActivate(context) as Promise<boolean>);
      agentAuthenticated =
        this.attachAgentContextFromAuthenticatedUser(request);
    }

    if (ssoToken && agentAuthenticated) {
      const agentPrincipal = (request as any).user;
      await this.authenticateSso(request, ssoToken, isAgentRequest);
      const delegatedUser = (request as any).user?.user;
      (request as any).user = agentPrincipal;
      const agentAccess = getAgentAccessContext(request as any);
      if (!agentAccess || !delegatedUser) {
        throw new UnauthorizedException();
      }
      if (delegatedUser.workspaceId !== agentAccess.workspace.id) {
        throw new UnauthorizedException('Workspace does not match');
      }
      agentAccess.delegatedUser = delegatedUser;
      ssoAuthenticated = true;
    } else if (
      ssoToken &&
      policy === AuthCredentialPolicy.SSO_OR_AGENT &&
      !bearerToken
    ) {
      await this.authenticateSso(request, ssoToken, isAgentRequest);
      ssoAuthenticated = true;
    } else if (ssoToken && bearerToken && !agentAuthenticated) {
      throw new UnauthorizedException('Unsupported credential combination');
    }

    if (
      policy === AuthCredentialPolicy.SSO_OR_AGENT &&
      !agentAuthenticated &&
      !ssoAuthenticated
    ) {
      throw new UnauthorizedException();
    }
    if (
      (policy === AuthCredentialPolicy.AGENT_WITH_OPTIONAL_SSO ||
        policy === AuthCredentialPolicy.AGENT_AND_SSO) &&
      !agentAuthenticated
    ) {
      throw new UnauthorizedException('Agent API key is required');
    }
    if (policy === AuthCredentialPolicy.AGENT_AND_SSO && !ssoAuthenticated) {
      throw new UnauthorizedException('SSO credential is required');
    }

    if (agentAuthenticated) {
      const capability = this.reflector.getAllAndOverride(AGENT_CAPABILITY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!capability && policy === AuthCredentialPolicy.DEFAULT) {
        throw new ForbiddenException('Agent API key cannot call this endpoint');
      }
    } else if (ssoAuthenticated) {
      this.setJoinedWorkspacesCookie((request as any).user, context);
    }

    return true;
  }

  private async authenticateAgentApiKey(
    request: FastifyRequest,
    token: string,
  ): Promise<void> {
    const workspace =
      (request.raw as any)?.workspace ?? (request as any).workspace;
    if (!workspace?.id) {
      throw new UnauthorizedException('Workspace is required');
    }

    const result = await this.validateAgentApiKey(token, workspace.id);
    (request as any).user = { user: result.user, workspace: result.workspace };
    (request.raw as any).workspace = result.workspace;
    if (!this.attachAgentContextFromAuthenticatedUser(request)) {
      throw new UnauthorizedException('An Agent API key is required');
    }
  }

  private async validateAgentApiKey(token: string, workspaceId?: string) {
    if (!workspaceId) {
      throw new UnauthorizedException('Workspace is required');
    }

    let apiKeyService: {
      validatePublicApiKey: (
        token: string,
        workspaceId: string,
      ) => Promise<{ user: any; workspace: any }>;
    };
    try {
      // Keep the core auth module independent from the enterprise API-key module.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ApiKeyService } = require('../../features/api-key/api-key.service');
      apiKeyService = this.moduleRef.get(ApiKeyService, { strict: false });
    } catch {
      throw new UnauthorizedException(
        'Agent API key authentication unavailable',
      );
    }
    if (!apiKeyService) {
      throw new UnauthorizedException(
        'Agent API key authentication unavailable',
      );
    }
    return apiKeyService.validatePublicApiKey(token, workspaceId);
  }

  private attachAgentContextFromAuthenticatedUser(
    request: FastifyRequest,
  ): boolean {
    const principal = (request as any).user;
    const access = getApiKeyAccess(principal?.user);
    if (
      !principal?.user ||
      !principal?.workspace ||
      !isAgentApiKeyAccess(access)
    ) {
      return false;
    }

    setAgentAccessContext(request as any, {
      apiKeyId: access.apiKeyId,
      credentialVersion: access.credentialVersion,
      agentUser: principal.user,
      workspace: principal.workspace,
    });
    return true;
  }

  private async authenticateSso(
    request: FastifyRequest,
    token: string,
    isAgentRequest = false,
  ): Promise<void> {
    const workspace =
      (request.raw as any)?.workspace ?? (request as any).workspace;
    if (!workspace?.id) {
      throw new UnauthorizedException('Workspace is required');
    }

    const ssoApi = this.environmentService.getHoidcSsoApi();
    const platformId = this.environmentService.getHoidcPlatformId();
    if (!ssoApi || !platformId) {
      throw new UnauthorizedException('SSO authentication is not configured');
    }

    // Keep the core auth module independent from the enterprise SSO module.
    // ModuleRef resolves HoidcService when EE is bundled and gives a clear
    // 401 when this build does not include SSO support.
    let hoidcService: {
      verifyToken: (
        config: {
          ssoApi: string;
          platformId: string;
          workspaceId: string;
          allowSignup: boolean;
        },
        token: string,
      ) => Promise<{
        email: string;
        name: string | null;
        avatar: string | null;
      }>;
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { HoidcService } = require('../../ee/sso/hoidc.service');
      hoidcService = this.moduleRef.get(HoidcService, { strict: false });
    } catch {
      throw new UnauthorizedException('SSO authentication is unavailable');
    }
    if (!hoidcService) {
      throw new UnauthorizedException('SSO authentication is unavailable');
    }

    let info: Awaited<ReturnType<typeof hoidcService.verifyToken>>;
    try {
      info = await hoidcService.verifyToken(
        {
          ssoApi,
          platformId,
          workspaceId: workspace.id,
          // API authentication must not implicitly create workspace members.
          allowSignup: false,
        },
        token,
      );
    } catch (error) {
      // iself's agent proxy forwards a digital-employee token (marked by the
      // X-Iself-Agent header) that a regular access-token verify cannot parse.
      // Fall back to the agent-token verifier, which hits a different upstream
      // endpoint and response contract, then map it to the real workspace user.
      if (isAgentRequest) {
        await this.authenticateAgent(request, token, {
          ssoApi,
          platformId,
          workspace,
        });
        return;
      }
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('SSO token validation failed');
    }
    const user = await this.userRepo.findByEmail(info.email, workspace.id);
    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException(
        'SSO user is not a member of this workspace',
      );
    }

    (request as any).user = { user, workspace };
    (request.raw as any).workspace = workspace;
    (request as any).sso = { email: info.email };
  }

  private async authenticateAgent(
    request: FastifyRequest,
    token: string,
    ctx: { ssoApi: string; platformId: string; workspace: { id: string } },
  ): Promise<void> {
    let hoidcService: {
      verifyAgentToken: (
        config: { ssoApi: string; platformId: string },
        token: string,
      ) => Promise<{
        uid: number;
        email: string;
        name: string | null;
        digital_employee_id?: string;
        target_platform_id?: string;
      }>;
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { HoidcService } = require('../../ee/sso/hoidc.service');
      hoidcService = this.moduleRef.get(HoidcService, { strict: false });
    } catch {
      throw new UnauthorizedException('SSO authentication is unavailable');
    }
    if (!hoidcService) {
      throw new UnauthorizedException('SSO authentication is unavailable');
    }

    const agentInfo = await hoidcService.verifyAgentToken(
      { ssoApi: ctx.ssoApi, platformId: ctx.platformId },
      token,
    );

    const user = await this.userRepo.findByEmail(
      agentInfo.email,
      ctx.workspace.id,
    );
    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException(
        'SSO user is not a member of this workspace',
      );
    }

    (request as any).user = { user, workspace: ctx.workspace };
    (request.raw as any).workspace = ctx.workspace;
    (request as any).sso = { email: agentInfo.email };
    (request as any).iselfAgent = {
      uid: agentInfo.uid,
      digitalEmployeeId: agentInfo.digital_employee_id,
      targetPlatformId: agentInfo.target_platform_id,
    };
  }

  handleRequest(err: any, user: any, info: any, ctx: ExecutionContext) {
    if (err || !user) {
      throw err || new UnauthorizedException();
    }

    if (!isAgentApiKeyAccess(getApiKeyAccess(user.user))) {
      this.setJoinedWorkspacesCookie(user, ctx);
    }
    return user;
  }

  setJoinedWorkspacesCookie(user: any, ctx: ExecutionContext) {
    if (this.environmentService.isCloud()) {
      const req = ctx.switchToHttp().getRequest();
      const res = ctx.switchToHttp().getResponse();

      const workspaceId = user?.workspace?.id;
      let workspaceIds = [];
      try {
        workspaceIds = req.cookies.joinedWorkspaces
          ? JSON.parse(req.cookies.joinedWorkspaces)
          : [];
      } catch (err) {
        /* empty */
      }

      if (!workspaceIds.includes(workspaceId)) {
        workspaceIds.push(workspaceId);
      }

      res.setCookie('joinedWorkspaces', JSON.stringify(workspaceIds), {
        httpOnly: false,
        domain: '.' + this.environmentService.getSubdomainHost(),
        path: '/',
        expires: addDays(new Date(), 365),
        secure: this.environmentService.isHttps(),
      });
    }
  }
}
