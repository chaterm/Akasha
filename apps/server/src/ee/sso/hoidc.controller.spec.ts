import { BadRequestException } from '@nestjs/common';
import { HoidcController } from './hoidc.controller';

describe('HoidcController', () => {
  const environmentService = {
    getHoidcSsoApi: jest.fn(() => 'https://sso.example.com'),
    getHoidcPlatformId: jest.fn(() => 'platform-1'),
    isHoidcAllowSignup: jest.fn(() => true),
    getCookieExpiresIn: jest.fn(() => new Date('2030-01-01T00:00:00Z')),
    isHttps: jest.fn(() => true),
    getAppUrl: jest.fn(() => 'https://app.example.com'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the first database workspace for HOIDC login', async () => {
    const hoidcService = {
      verifyToken: jest.fn().mockResolvedValue({
        email: 'user@example.com',
        name: 'User',
        avatar: null,
      }),
      loginUser: jest.fn().mockResolvedValue('auth-token'),
    };
    const workspaceRepo = {
      findFirst: jest.fn().mockResolvedValue({ id: 'workspace-from-db' }),
    };
    const response = {
      setCookie: jest.fn(),
      redirect: jest.fn(),
    };
    const controller = new HoidcController(
      hoidcService as any,
      environmentService as any,
      workspaceRepo as any,
    );

    await controller.callback(
      'sso-token',
      undefined,
      {} as any,
      response as any,
    );

    expect(workspaceRepo.findFirst).toHaveBeenCalledTimes(1);
    expect(hoidcService.verifyToken).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-from-db' }),
      'sso-token',
    );
    expect(hoidcService.loginUser).toHaveBeenCalledWith({
      config: expect.objectContaining({ workspaceId: 'workspace-from-db' }),
      info: {
        email: 'user@example.com',
        name: 'User',
        avatar: null,
      },
    });
  });

  it('rejects HOIDC login when the database has no workspace', async () => {
    const hoidcService = {
      verifyToken: jest.fn(),
      loginUser: jest.fn(),
    };
    const workspaceRepo = {
      findFirst: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new HoidcController(
      hoidcService as any,
      environmentService as any,
      workspaceRepo as any,
    );

    await expect(
      controller.callback(
        'sso-token',
        undefined,
        {} as any,
        { setCookie: jest.fn(), redirect: jest.fn() } as any,
      ),
    ).rejects.toThrow(new BadRequestException('Workspace is not initialized'));

    expect(hoidcService.verifyToken).not.toHaveBeenCalled();
  });
});
