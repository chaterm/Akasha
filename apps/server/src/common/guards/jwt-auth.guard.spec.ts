import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { withApiKeyAccess } from '../auth/api-key-access';
import { ApiKeyType } from '../auth/api-key-type';
import { AuthController } from '../../core/auth/auth.controller';
import { SessionController } from '../../core/session/session.controller';
import { UserController } from '../../core/user/user.controller';
import { ApiKeyController } from '../../features/api-key/api-key.controller';
import { IselfAgentSpaceController } from '../../features/api-key/iself-agent-space.controller';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthCredentialPolicy } from '../auth/auth-credential-policy';

jest.mock('../../core/auth/services/auth.service', () => ({
  AuthService: class {},
}));
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
    publicKey?: string;
    bearer?: string;
    workspace?: { id: string } | undefined;
  }) => {
    const request: any = {
      headers: {},
      raw: { workspace: opts.workspace },
    };
    if (opts.xToken !== undefined) request.headers['x-token'] = opts.xToken;
    if (opts.agent !== undefined) request.headers['x-iself-agent'] = opts.agent;
    if (opts.publicKey !== undefined)
      request.headers['x-akasha-public-key'] = opts.publicKey;
    if (opts.bearer !== undefined)
      request.headers['authorization'] = `Bearer ${opts.bearer}`;
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

describe('JwtAuthGuard agent key scope', () => {
  const activeUser = { id: 'u1', deletedAt: null, deactivatedAt: null };
  const scope = {
    apiKeyId: 'key-1',
    credentialVersion: 1,
    agentUser: { id: 'agent-1' },
    workspace: { id: 'ws-1' },
    spaceIds: ['sp-1'],
  };

  const reflector = { getAllAndOverride: jest.fn() };
  const environmentService = {
    getHoidcSsoApi: jest.fn().mockReturnValue('https://sso.example'),
    getHoidcPlatformId: jest.fn().mockReturnValue('platform-1'),
    isCloud: jest.fn().mockReturnValue(false),
  };
  const hoidcService = { verifyToken: jest.fn(), verifyAgentToken: jest.fn() };
  const apiKeyService = { validateAgentApiKeyScope: jest.fn() };
  const moduleRef = { get: jest.fn() };
  const userRepo = { findByEmail: jest.fn() };

  const guard = new JwtAuthGuard(
    reflector as any,
    environmentService as any,
    moduleRef as any,
    userRepo as any,
  );

  const makeContext = (headers: Record<string, string>) => {
    const request: any = { headers, raw: { workspace: { id: 'ws-1' } } };
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

  const capability = (value: unknown) =>
    reflector.getAllAndOverride.mockImplementation((key: string) =>
      key === 'agentCapability' ? value : false,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    capability('page.read');
    hoidcService.verifyToken.mockResolvedValue({ email: 'u1@example.com' });
    userRepo.findByEmail.mockResolvedValue(activeUser);
    apiKeyService.validateAgentApiKeyScope.mockResolvedValue(scope);
    moduleRef.get.mockImplementation((token: any) =>
      token?.name === 'ApiKeyService' ? apiKeyService : hoidcService,
    );
  });

  it('attaches the key as scope on top of the SSO identity', async () => {
    const { context, request } = makeContext({
      'x-token': 'sso-token',
      'x-akasha-public-key': 'agent-token',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      user: activeUser,
      workspace: { id: 'ws-1' },
    });
    expect(request.agentAccess).toEqual(scope);
    expect(apiKeyService.validateAgentApiKeyScope).toHaveBeenCalledWith(
      'agent-token',
      'ws-1',
    );
  });

  it('resolves no identity from the key alone, so the bearer strategy runs', async () => {
    const { context } = makeContext({ 'x-akasha-public-key': 'agent-token' });

    await expect(guard.canActivate(context)).rejects.toThrow();
    expect(hoidcService.verifyToken).not.toHaveBeenCalled();
    expect(apiKeyService.validateAgentApiKeyScope).not.toHaveBeenCalled();
  });

  it('rejects an SSO token combined with a bearer token', async () => {
    const { context } = makeContext({
      'x-token': 'sso-token',
      authorization: 'Bearer personal-token',
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      'Unsupported credential combination',
    );
  });

  it('forbids a key on an endpoint that declares no capability', async () => {
    capability(undefined);
    const { context } = makeContext({
      'x-token': 'sso-token',
      'x-akasha-public-key': 'agent-token',
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      'Agent API key cannot call this endpoint',
    );
  });

  it('requires a key when the endpoint declares AGENT_SCOPE_REQUIRED', async () => {
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === 'agentCapability') return 'knowledge.query';
      if (key === 'authCredentialPolicy')
        return AuthCredentialPolicy.AGENT_SCOPE_REQUIRED;
      return false;
    });
    const { context } = makeContext({ 'x-token': 'sso-token' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      'Agent API key is required',
    );
  });
});

describe('personal key HTTP endpoint policy', () => {
  const sessionUser = {
    id: 'u1',
  } as import('@akasha/db/types/entity.types').User;
  const user = withApiKeyAccess(sessionUser, {
    apiKeyId: 'personal-1',
    personalSpaceId: null,
    keyType: ApiKeyType.PERSONAL,
  });
  const workspace = { id: 'ws-1' };
  const validateAgentApiKeyScope = jest.fn().mockResolvedValue({
    apiKeyId: 'agent-key',
    workspace,
    spaceIds: [],
  });
  const guard = new JwtAuthGuard(
    new Reflector(),
    { isCloud: () => false } as any,
    { get: () => ({ validateAgentApiKeyScope }) } as any,
    {} as any,
  );

  function authorize(
    controller: Function,
    handler: Function,
    principal: typeof user,
    agent = false,
  ) {
    const request = {
      headers: agent ? { 'x-akasha-public-key': 'agent-token' } : {},
      user: { user: principal, workspace },
    };
    const context = {
      getHandler: () => handler,
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return guard.canActivate(context);
  }

  beforeEach(() => {
    jest
      .spyOn(AuthGuard('jwt').prototype, 'canActivate')
      .mockResolvedValue(true);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [ApiKeyController, ApiKeyController.prototype.createApiKey],
    [AuthController, AuthController.prototype.changePassword],
    [AuthController, AuthController.prototype.collabToken],
    [SessionController, SessionController.prototype.revokeSession],
    [SessionController, SessionController.prototype.revokeAllSessions],
    [UserController, UserController.prototype.updateUser],
  ])(
    'applies the blacklist before business logic',
    async (controller, handler) => {
      await expect(authorize(controller, handler, user)).rejects.toMatchObject({
        status: 403,
        response: { code: 'PERSONAL_API_KEY_FORBIDDEN' },
      });
      await expect(authorize(controller, handler, sessionUser)).resolves.toBe(
        true,
      );
    },
  );

  it('allows ordinary HTTP and scoped iself binding updates', async () => {
    await expect(
      authorize(
        SessionController,
        SessionController.prototype.listSessions,
        user,
      ),
    ).resolves.toBe(true);
    const update = IselfAgentSpaceController.prototype.replaceBindings;
    await expect(
      authorize(IselfAgentSpaceController, update, user),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authorize(IselfAgentSpaceController, update, user, true),
    ).resolves.toBe(true);
    await expect(
      authorize(
        ApiKeyController,
        ApiKeyController.prototype.createApiKey,
        user,
        true,
      ),
    ).rejects.toMatchObject({
      response: { code: 'PERSONAL_API_KEY_FORBIDDEN' },
    });
  });
});
