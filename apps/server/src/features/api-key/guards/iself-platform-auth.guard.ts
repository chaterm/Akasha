import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { FastifyRequest } from 'fastify';
import { EnvironmentService } from '../../../integrations/environment/environment.service';

@Injectable()
export class IselfPlatformAuthGuard implements CanActivate {
  constructor(private readonly environmentService: EnvironmentService) {}

  canActivate(context: ExecutionContext): boolean {
    const configuredSecret = this.environmentService
      .getIselfApiKeySecret()
      .trim();
    if (!configuredSecret) {
      throw new ServiceUnavailableException(
        'iself API-key provisioning is not configured',
      );
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers['x-iself-secret'];
    const rawSecret = Array.isArray(header) ? header[0] : header;
    const secret =
      typeof rawSecret === 'string' && rawSecret.trim()
        ? rawSecret.trim()
        : undefined;
    if (!secret) {
      throw new UnauthorizedException();
    }

    const expected = createHash('sha256').update(configuredSecret).digest();
    const actual = createHash('sha256').update(secret).digest();
    if (!timingSafeEqual(expected, actual)) {
      throw new UnauthorizedException();
    }

    return true;
  }
}
