import { getApiKeyAccess } from '../../common/auth/api-key-access';
import { UserRole } from '../../common/helpers/types/permission';
import { ApiKeyService } from './api-key.service';
import { ApiKeyType } from '../../common/auth/api-key-type';

describe('ApiKeyService authentication context', () => {
  it('resolves the current user personal space when validating a key', async () => {
    const apiKeyRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'key-1',
        creatorId: 'user-1',
        expiresAt: null,
      }),
      updateLastUsed: jest.fn().mockResolvedValue(undefined),
    };
    const userRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'user-1',
        name: 'fish',
        email: 'fish@example.com',
        role: UserRole.MEMBER,
      }),
    };
    const workspaceRepo = {
      findById: jest.fn().mockResolvedValue({ id: 'workspace-1' }),
    };
    const spaceRepo = {
      findPersonalSpaceForUser: jest
        .fn()
        .mockResolvedValue({ id: 'personal-1' }),
    };
    const service = new ApiKeyService(
      apiKeyRepo as any,
      {} as any,
      userRepo as any,
      workspaceRepo as any,
      spaceRepo as any,
    );

    const result = await service.validateApiKey({
      sub: 'user-1',
      workspaceId: 'workspace-1',
      apiKeyId: 'key-1',
      type: 'api_key',
    });

    expect(getApiKeyAccess(result.user)).toEqual({
      apiKeyId: 'key-1',
      personalSpaceId: 'personal-1',
    });
    expect(spaceRepo.findPersonalSpaceForUser).toHaveBeenCalledWith({
      userId: 'user-1',
      workspaceId: 'workspace-1',
    });
  });

  it('validates a public retrieval key without resolving its creator as a user', async () => {
    const apiKeyRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'public-1',
        keyType: ApiKeyType.PUBLIC_RETRIEVAL,
        expiresAt: null,
      }),
      findSpaceIdsByApiKeyId: jest
        .fn()
        .mockResolvedValue(['space-1', 'space-2']),
      updateLastUsed: jest.fn().mockResolvedValue(undefined),
    };
    const tokenService = {
      verifyJwt: jest.fn().mockResolvedValue({
        apiKeyId: 'public-1',
        workspaceId: 'workspace-1',
        type: 'public_api_key',
      }),
    };
    const userRepo = { findById: jest.fn() };
    const service = new ApiKeyService(
      apiKeyRepo as any,
      tokenService as any,
      userRepo as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.validatePublicApiKey('public-token', 'workspace-1'),
    ).resolves.toEqual({
      apiKeyId: 'public-1',
      workspaceId: 'workspace-1',
      spaceIds: ['space-1', 'space-2'],
    });
    expect(userRepo.findById).not.toHaveBeenCalled();
  });

  it('creates a public key only with bindable workspace Spaces', async () => {
    const apiKeyRepo = {
      findBindableSpaceIds: jest.fn().mockResolvedValue(['space-1', 'space-2']),
      createWithSpaces: jest.fn().mockResolvedValue({
        id: 'public-1',
        keyType: ApiKeyType.PUBLIC_RETRIEVAL,
      }),
    };
    const tokenService = {
      generatePublicApiToken: jest.fn().mockResolvedValue('public-token'),
    };
    const userRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'admin-1',
        role: UserRole.ADMIN,
        name: 'Admin',
        email: 'admin@example.com',
      }),
    };
    const service = new ApiKeyService(
      apiKeyRepo as any,
      tokenService as any,
      userRepo as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.createPublicApiKey({
        name: 'Robot',
        creatorId: 'admin-1',
        workspaceId: 'workspace-1',
        spaceIds: ['space-1', 'space-2'],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'public-1',
        token: 'public-token',
        spaces: [{ id: 'space-1' }, { id: 'space-2' }],
      }),
    );
    expect(apiKeyRepo.createWithSpaces).toHaveBeenCalledWith(
      expect.objectContaining({
        keyType: ApiKeyType.PUBLIC_RETRIEVAL,
        creatorId: 'admin-1',
        workspaceId: 'workspace-1',
      }),
      ['space-1', 'space-2'],
    );
  });
});
