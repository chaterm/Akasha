import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { HoidcService } from '../../sso/hoidc.service';

/**
 * Authenticates the digital employee token injected by iself's agent proxy.
 * The verified SSO email is mapped to the local workspace user so all normal
 * knowledge ACL checks continue to run under the real user's identity.
 */
@Injectable()
export class IsElfAgentAuthGuard implements CanActivate {
  constructor(
    private readonly hoidcService: HoidcService,
    private readonly userRepo: UserRepo,
    private readonly environmentService: EnvironmentService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const tokenHeader = request.headers['x-token'];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException('X-Token is required');
    }

    const workspace =
      (request.raw as any)?.workspace ?? (request as any).workspace;
    if (!workspace?.id) {
      throw new UnauthorizedException('Workspace is required');
    }

    const ssoApi = this.environmentService.getHoidcSsoApi();
    const platformId = this.environmentService.getHoidcPlatformId();
    if (!ssoApi || !platformId) {
      throw new UnauthorizedException(
        'HOIDC agent authentication is not configured',
      );
    }

    const agentInfo = await this.hoidcService.verifyAgentToken(
      { ssoApi, platformId },
      token,
    );
    const user = await this.userRepo.findByEmail(agentInfo.email, workspace.id);
    if (!user || user.deactivatedAt) {
      throw new UnauthorizedException(
        'SSO user is not a member of this workspace',
      );
    }

    (request as any).user = { user, workspace };
    (request.raw as any).workspace = workspace;
    (request as any).iselfAgent = {
      uid: agentInfo.uid,
      digitalEmployeeId: agentInfo.digital_employee_id,
      targetPlatformId: agentInfo.target_platform_id,
    };
    return true;
  }
}
