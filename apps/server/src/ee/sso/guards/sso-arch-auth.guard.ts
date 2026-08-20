import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  AUDIT_CONTEXT_KEY,
  AuditContext,
} from '../../../common/middlewares/audit-context.middleware';

@Injectable()
export class SsoArchAuthGuard implements CanActivate {
  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly cls: ClsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const configuredToken = this.environmentService.getSsoArchToken().trim();
    if (!configuredToken) {
      throw new ServiceUnavailableException(
        'SSO organization APIs are not configured',
      );
    }

    const request = context.switchToHttp().getRequest();
    const authorization = request.headers?.authorization;
    const [scheme, token] = authorization?.split(' ') ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException();
    }

    const expected = createHash('sha256').update(configuredToken).digest();
    const actual = createHash('sha256').update(token).digest();
    if (!timingSafeEqual(expected, actual)) {
      throw new UnauthorizedException();
    }

    const auditContext = this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (auditContext) {
      auditContext.actorId = null;
      auditContext.actorType = 'arch';
      this.cls.set(AUDIT_CONTEXT_KEY, auditContext);
    }

    return true;
  }
}
