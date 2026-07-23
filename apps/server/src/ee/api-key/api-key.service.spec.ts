import { getApiKeyAccess } from '../../common/auth/api-key-access';
import { UserRole } from '../../common/helpers/types/permission';
import { ApiKeyService } from './api-key.service';

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
});
