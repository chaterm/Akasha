import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { SsoArchAuthGuard } from './sso-arch-auth.guard';

describe('SsoArchAuthGuard', () => {
  const environmentService = {
    getSsoArchToken: jest.fn(),
  };
  const cls = {
    get: jest.fn().mockReturnValue({
      actorId: null,
      actorType: 'user',
    }),
    set: jest.fn(),
  } as unknown as ClsService;
  const guard = new SsoArchAuthGuard(environmentService as any, cls);

  const context = (authorization?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization } }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    jest.clearAllMocks();
    environmentService.getSsoArchToken.mockReturnValue('secret-token');
  });

  it('accepts the configured bearer token and marks the request as Arch activity', () => {
    expect(guard.canActivate(context('Bearer secret-token'))).toBe(true);
    expect(cls.set).toHaveBeenCalledWith(
      'auditContext',
      expect.objectContaining({ actorId: null, actorType: 'arch' }),
    );
  });

  it('rejects missing or invalid credentials', () => {
    expect(() => guard.canActivate(context())).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context('Bearer invalid'))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects requests when the server credential is not configured', () => {
    environmentService.getSsoArchToken.mockReturnValue('');
    expect(() => guard.canActivate(context('Bearer secret-token'))).toThrow(
      ServiceUnavailableException,
    );
  });
});
