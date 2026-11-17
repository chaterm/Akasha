import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

jest.mock('../../ee/sso/hoidc.service', () => ({ HoidcService: class {} }));

describe('JwtAuthGuard SSO / iself-agent auth', () => {
  const reflector = { getAllAndOverride: jest.fn() };
  const environmentService = {
    getHoidcSsoApi: jest.fn(),
    getHoidcPlatformId: jest.fn(),
    isCloud: jest.fn(),
  };
  const hoidcService = {
    verifyToken: jest.fn(),
    verifyAgentToken: jest.fn(),
  };
  const moduleRef = { get: jest.fn() };
  const userRepo = { findByEmail: jest.fn() };

  const guard = new JwtAuthGuard(
    reflector as any,
    environmentService as any,
    moduleRef as any,
    userRepo as any,
  );

  const activeUser = { id: 'u1', deletedAt: null, deactivatedAt: null };

  const makeContext = (opts: {
    xToken?: string;
    agent?: string;
    workspace?: { id: string } | undefined;
  }) => {
    const request: any = {
      headers: {},
      raw: { workspace: opts.workspace },
    };
    if (opts.xToken !== undefined) request.headers['x-token'] = opts.xToken;
    if (opts.agent !== undefined) request.headers['x-iself-agent'] = opts.agent;
    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ setCookie: jest.fn() }),
      }),
    } as unknown as ExecutionContext;
    return { context, request };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    reflector.getAllAndOverride.mockReturnValue(false);
    environmentService.getHoidcSsoApi.mockReturnValue('https://sso.example');
    environmentService.getHoidcPlatformId.mockReturnValue('platform-1');
    environmentService.isCloud.mockReturnValue(false);
    moduleRef.get.mockReturnValue(hoidcService);
  });

  it('authenticates a regular SSO token without touching the agent verifier', async () => {
    hoidcService.verifyToken.mockResolvedValue({
      email: 'user@example.com',
      name: 'User',
      avatar: null,
    });
    userRepo.findByEmail.mockResolvedValue(activeUser);

    const { context, request } = makeContext({
      xToken: 'sso-token',
      workspace: { id: 'ws-1' },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(hoidcService.verifyAgentToken).not.toHaveBeenCalled();
    expect(request.user).toEqual({
      user: activeUser,
      workspace: { id: 'ws-1' },
    });
    expect(request.sso).toEqual({ email: 'user@example.com' });
    expect(request.iselfAgent).toBeUndefined();
  });

  it('falls back to the agent-token verifier when X-Iself-Agent:1 and verifyToken fails', async () => {
    hoidcService.verifyToken.mockRejectedValue(
      new UnauthorizedException('SSO response missing email'),
    );
    hoidcService.verifyAgentToken.mockResolvedValue({
      uid: 42,
      email: 'agent-user@example.com',
      name: 'Agent User',
      digital_employee_id: 'de-1',
      target_platform_id: 'tp-1',
    });
    userRepo.findByEmail.mockResolvedValue(activeUser);

    const { context, request } = makeContext({
      xToken: 'agent-token',
      agent: '1',
      workspace: { id: 'ws-1' },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(hoidcService.verifyAgentToken).toHaveBeenCalledWith(
      { ssoApi: 'https://sso.example', platformId: 'platform-1' },
      'agent-token',
    );
    expect(userRepo.findByEmail).toHaveBeenLastCalledWith(
      'agent-user@example.com',
      'ws-1',
    );
    expect(request.user).toEqual({
      user: activeUser,
      workspace: { id: 'ws-1' },
    });
    expect(request.sso).toEqual({ email: 'agent-user@example.com' });
    expect(request.iselfAgent).toEqual({
      uid: 42,
      digitalEmployeeId: 'de-1',
      targetPlatformId: 'tp-1',
    });
  });

  it('rejects when the agent token itself is invalid', async () => {
    hoidcService.verifyToken.mockRejectedValue(
      new UnauthorizedException('SSO response missing email'),
    );
    hoidcService.verifyAgentToken.mockRejectedValue(
      new UnauthorizedException('Invalid digital employee token'),
    );

    const { context } = makeContext({
      xToken: 'bad-agent-token',
      agent: '1',
      workspace: { id: 'ws-1' },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      'Invalid digital employee token',
    );
  });

  it('rejects an agent whose email is not a member of the workspace', async () => {
    hoidcService.verifyToken.mockRejectedValue(
      new UnauthorizedException('SSO response missing email'),
    );
    hoidcService.verifyAgentToken.mockResolvedValue({
      uid: 42,
      email: 'stranger@example.com',
      name: null,
    });
    userRepo.findByEmail.mockResolvedValue(null);

    const { context } = makeContext({
      xToken: 'agent-token',
      agent: '1',
      workspace: { id: 'ws-1' },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      'SSO user is not a member of this workspace',
    );
  });

  it('does NOT fall back to the agent verifier without X-Iself-Agent:1', async () => {
    hoidcService.verifyToken.mockRejectedValue(
      new UnauthorizedException('SSO response missing email'),
    );

    const { context } = makeContext({
      xToken: 'sso-token',
      workspace: { id: 'ws-1' },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      'SSO response missing email',
    );
    expect(hoidcService.verifyAgentToken).not.toHaveBeenCalled();
  });

  it('ignores the agent header when its value is not exactly "1"', async () => {
    hoidcService.verifyToken.mockRejectedValue(
      new UnauthorizedException('SSO response missing email'),
    );

    const { context } = makeContext({
      xToken: 'sso-token',
      agent: 'true',
      workspace: { id: 'ws-1' },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      'SSO response missing email',
    );
    expect(hoidcService.verifyAgentToken).not.toHaveBeenCalled();
  });
});
