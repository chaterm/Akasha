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
import { setAgentAccessContext } from '../auth/agent-access-context';
import { getApiKeyAccess } from '../auth/api-key-access';
import { ApiKeyType } from '../auth/api-key-type';
import { ErrorCode, errorBody } from '../errors/error-codes';

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

    if (ssoToken && bearerToken) {
      throw new UnauthorizedException('Unsupported credential combination');
    }

    let ssoAuthenticated = false;
    if (ssoToken) {
      await this.authenticateSso(request, ssoToken, isAgentRequest);
      ssoAuthenticated = true;
    } else {
      await (super.canActivate(context) as Promise<boolean>);
    }

    if (publicKey) {
      await this.attachAgentScope(request, publicKey);
    } else if (policy === AuthCredentialPolicy.AGENT_SCOPE_REQUIRED) {
      throw new UnauthorizedException('Agent API key is required');
    }

    if (
      policy === AuthCredentialPolicy.PERSONAL_API_KEY_FORBIDDEN &&
      getApiKeyAccess((request as any).user.user)?.keyType ===
        ApiKeyType.PERSONAL
    ) {
      throw new ForbiddenException(
        errorBody(
          ErrorCode.PERSONAL_API_KEY_FORBIDDEN,
          'Personal API keys cannot access this endpoint',
        ),
      );
    }

    if (publicKey) {
      const capability = this.reflector.getAllAndOverride(AGENT_CAPABILITY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!capability) {
        throw new ForbiddenException('Agent API key cannot call this endpoint');
      }
    } else if (ssoAuthenticated) {
      this.setJoinedWorkspacesCookie((request as any).user, context);
    }

    return true;
  }

  private async attachAgentScope(
    request: FastifyRequest,
    token: string,
  ): Promise<void> {
    const principal = (request as any).user;
    if (!principal?.user || !principal?.workspace) {
      throw new UnauthorizedException();
    }

    let apiKeyService: {
      validateAgentApiKeyScope: (
        token: string,
        workspaceId: string,
      ) => Promise<{
        apiKeyId: string;
        credentialVersion: number;
        agentUser: any;
        workspace: any;
        spaceIds: string[];
      }>;
    };
    try {
      const {
        ApiKeyService,
        // eslint-disable-next-line @typescript-eslint/no-require-imports
      } = require('../../features/api-key/api-key.service');
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

    const scope = await apiKeyService.validateAgentApiKeyScope(
      token,
      principal.workspace.id,
    );
    setAgentAccessContext(request as any, scope);
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
          allowSignup: false,
        },
        token,
      );
    } catch (error) {
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

    this.setJoinedWorkspacesCookie(user, ctx);
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
