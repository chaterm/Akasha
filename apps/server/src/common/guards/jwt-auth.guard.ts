import {
  ExecutionContext,
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
import { isUserDisabled } from '../helpers';

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
    const tokenHeader = request.headers['x-token'];
    const ssoToken = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;

    // X-Token is reserved for SSO. Do not fall through to JWT/API-key auth
    // when it is present: otherwise a typo or an expired SSO token could be
    // interpreted as an unrelated credential.
    if (typeof ssoToken === 'string' && ssoToken.trim()) {
      await this.authenticateSso(request, ssoToken.trim());
      this.setJoinedWorkspacesCookie((request as any).user, context);
      return true;
    }

    return super.canActivate(context) as Promise<boolean>;
  }

  private async authenticateSso(
    request: FastifyRequest,
    token: string,
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
