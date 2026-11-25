import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthCredentialPolicy } from '../auth/auth-credential-policy';

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
  const tokenService = { decodeJwt: jest.fn(), verifyJwt: jest.fn() };

  const guard = new JwtAuthGuard(
    reflector as any,
    environmentService as any,
    moduleRef as any,
    userRepo as any,
    tokenService as any,
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
  const combinedScope = { ...scope, standalone: false };
  const standaloneScope = { ...scope, standalone: true };

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
  const tokenService = { decodeJwt: jest.fn(), verifyJwt: jest.fn() };

  const guard = new JwtAuthGuard(
    reflector as any,
    environmentService as any,
    moduleRef as any,
    userRepo as any,
    tokenService as any,
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
    expect(request.agentAccess).toEqual(combinedScope);
    expect(apiKeyService.validateAgentApiKeyScope).toHaveBeenCalledWith(
      'agent-token',
      'ws-1',
    );
  });

  it('authenticates the key alone as its agent user', async () => {
    const { context, request } = makeContext({
      'x-akasha-public-key': 'agent-token',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(hoidcService.verifyToken).not.toHaveBeenCalled();
    expect(apiKeyService.validateAgentApiKeyScope).toHaveBeenCalledWith(
      'agent-token',
      'ws-1',
    );
    expect(request.user).toEqual({
      user: scope.agentUser,
      workspace: scope.workspace,
    });
    expect(request.agentAccess).toEqual(standaloneScope);
  });

  it('forbids the key alone on an endpoint that declares no capability', async () => {
    capability(undefined);
    const { context } = makeContext({ 'x-akasha-public-key': 'agent-token' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      'Agent API key cannot call this endpoint',
    );
  });

  it('forbids the key alone on an endpoint that requires a user identity', async () => {
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === 'agentCapability') return 'space.binding.update';
      if (key === 'userIdentityRequired') return true;
      return false;
    });
    const { context } = makeContext({ 'x-akasha-public-key': 'agent-token' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      'This endpoint requires a user credential alongside the Agent API key',
    );
  });

  it('allows the key alongside a user identity on a UserIdentityRequired endpoint', async () => {
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === 'agentCapability') return 'space.binding.update';
      if (key === 'userIdentityRequired') return true;
      return false;
    });
    const { context, request } = makeContext({
      'x-token': 'sso-token',
      'x-akasha-public-key': 'agent-token',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      user: activeUser,
      workspace: { id: 'ws-1' },
    });
  });

  it('treats a session cookie plus the key as the combined mode', async () => {
    const { context, request } = makeContext({
      'x-akasha-public-key': 'agent-token',
    });
    (request as any).cookies = { authToken: 'session-token' };

    await expect(guard.canActivate(context)).rejects.toThrow();
    expect(apiKeyService.validateAgentApiKeyScope).not.toHaveBeenCalled();
  });

  it('rejects the key alone when the workspace is unresolved', async () => {
    const { context, request } = makeContext({
      'x-akasha-public-key': 'agent-token',
    });
    request.raw = {};

    await expect(guard.canActivate(context)).rejects.toThrow(
      'Workspace is required',
    );
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

describe('JwtAuthGuard MCP companion tokens', () => {
  const activeUser = { id: 'u1', deletedAt: null, deactivatedAt: null };
  const reflector = { getAllAndOverride: jest.fn() };
  const environmentService = {
    getHoidcSsoApi: jest.fn().mockReturnValue('https://sso.example'),
    getHoidcPlatformId: jest.fn().mockReturnValue('platform-1'),
    isCloud: jest.fn().mockReturnValue(false),
  };
  const moduleRef = { get: jest.fn() };
  const userRepo = { findByEmail: jest.fn(), findById: jest.fn() };
  const tokenService = { decodeJwt: jest.fn(), verifyJwt: jest.fn() };

  const guard = new JwtAuthGuard(
    reflector as any,
    environmentService as any,
    moduleRef as any,
    userRepo as any,
    tokenService as any,
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

  const policy = (value: unknown) =>
    reflector.getAllAndOverride.mockImplementation((key: string) =>
      key === 'authCredentialPolicy' ? value : false,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    policy(AuthCredentialPolicy.MCP_COMPANION_ALLOWED);
    userRepo.findById.mockResolvedValue(activeUser);
  });

  it('authenticates an upload token and records its scope', async () => {
    tokenService.decodeJwt.mockReturnValue({ type: 'mcp_upload' });
    tokenService.verifyJwt.mockResolvedValue({
      type: 'mcp_upload',
      sub: 'u1',
      workspaceId: 'ws-1',
      pageId: 'page-1',
    });
    const { context, request } = makeContext({
      authorization: 'Bearer upload-token',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      user: activeUser,
      workspace: { id: 'ws-1' },
    });
    expect(request.mcpCompanion).toEqual({
      type: 'mcp_upload',
      userId: 'u1',
      workspaceId: 'ws-1',
      pageId: 'page-1',
    });
  });

  it('rejects an upload token minted for another workspace', async () => {
    tokenService.decodeJwt.mockReturnValue({ type: 'mcp_upload' });
    tokenService.verifyJwt.mockResolvedValue({
      type: 'mcp_upload',
      sub: 'u1',
      workspaceId: 'ws-2',
      pageId: 'page-1',
    });
    const { context } = makeContext({ authorization: 'Bearer upload-token' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      'Workspace does not match',
    );
  });

  it('ignores companion tokens on endpoints that do not opt in', async () => {
    policy(AuthCredentialPolicy.DEFAULT);
    tokenService.decodeJwt.mockReturnValue({ type: 'mcp_upload' });
    const { context } = makeContext({ authorization: 'Bearer upload-token' });

    await expect(guard.canActivate(context)).rejects.toThrow();
    expect(tokenService.verifyJwt).not.toHaveBeenCalled();
  });

  it('falls through to the bearer strategy for non-companion tokens', async () => {
    tokenService.decodeJwt.mockReturnValue({ type: 'api_key' });
    const { context } = makeContext({ authorization: 'Bearer api-key-token' });

    await expect(guard.canActivate(context)).rejects.toThrow();
    expect(tokenService.verifyJwt).not.toHaveBeenCalled();
  });

  it('refuses a companion token paired with an agent key', async () => {
    tokenService.decodeJwt.mockReturnValue({ type: 'mcp_upload' });
    const { context } = makeContext({
      authorization: 'Bearer upload-token',
      'x-akasha-public-key': 'agent-token',
    });

    await expect(guard.canActivate(context)).rejects.toThrow();
    expect(tokenService.verifyJwt).not.toHaveBeenCalled();
  });
});
