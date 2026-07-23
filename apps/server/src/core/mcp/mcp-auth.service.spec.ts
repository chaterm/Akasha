import { UnauthorizedException } from '@nestjs/common';
import { McpAuthService } from './mcp-auth.service';
import { JwtType } from '../auth/dto/jwt-payload';

describe('McpAuthService', () => {
  const apiKeyRepo = {
    findById: jest.fn(),
    updateLastUsed: jest.fn(),
  };
  const tokenService = {
    verifyJwt: jest.fn(),
  };
  const userRepo = {
    findById: jest.fn(),
  };
  const workspaceRepo = {
    findById: jest.fn(),
  };

  const service = new McpAuthService(
    apiKeyRepo as any,
    tokenService as any,
    userRepo as any,
    workspaceRepo as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    apiKeyRepo.updateLastUsed.mockResolvedValue(undefined);
  });

  it('rejects requests without a bearer token', async () => {
    await expect(
      service.authenticate({ headers: {}, raw: {} } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('validates an active API key and returns the user and workspace', async () => {
    const workspace = { id: 'workspace-1', settings: { ai: { mcp: true } } };
    const user = { id: 'user-1', workspaceId: 'workspace-1' };

    tokenService.verifyJwt.mockResolvedValue({
      type: JwtType.API_KEY,
      apiKeyId: 'key-1',
      sub: user.id,
      workspaceId: workspace.id,
    });
    apiKeyRepo.findById.mockResolvedValue({
      id: 'key-1',
      expiresAt: null,
    });
    workspaceRepo.findById.mockResolvedValue(workspace);
    userRepo.findById.mockResolvedValue(user);

    await expect(
      service.authenticate({
        headers: { authorization: 'Bearer token' },
        raw: { workspaceId: workspace.id },
      } as any),
    ).resolves.toEqual({ user, workspace });

    expect(tokenService.verifyJwt).toHaveBeenCalledWith(
      'token',
      JwtType.API_KEY,
    );
    expect(apiKeyRepo.updateLastUsed).toHaveBeenCalledWith('key-1');
  });

  it('rejects a token for a different routed workspace', async () => {
    tokenService.verifyJwt.mockResolvedValue({
      type: JwtType.API_KEY,
      apiKeyId: 'key-1',
      sub: 'user-1',
      workspaceId: 'workspace-1',
    });

    await expect(
      service.authenticate({
        headers: { authorization: 'Bearer token' },
        raw: { workspaceId: 'workspace-2' },
      } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects revoked API keys', async () => {
    tokenService.verifyJwt.mockResolvedValue({
      type: JwtType.API_KEY,
      apiKeyId: 'key-1',
      sub: 'user-1',
      workspaceId: 'workspace-1',
    });
    apiKeyRepo.findById.mockResolvedValue(null);

    await expect(
      service.authenticate({
        headers: { authorization: 'Bearer token' },
        raw: { workspaceId: 'workspace-1' },
      } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
