import { UserRole } from '../../common/helpers/types/permission';
import { withApiKeyAccess } from '../../common/auth/api-key-access';
import { UserController } from './user.controller';

describe('UserController', () => {
  const createSubject = () => {
    const workspaceRepo = {
      getActiveUserCount: jest.fn().mockResolvedValue(3),
    };
    const spaceRepo = {
      findPersonalSpaceForUser: jest
        .fn()
        .mockResolvedValue({ id: 'personal-1' }),
    };
    const controller = new UserController(
      {} as any,
      workspaceRepo as any,
      spaceRepo as any,
    );
    const user = {
      id: 'user-1',
      name: 'fish',
      email: 'fish@example.com',
      role: UserRole.MEMBER,
    } as any;
    const workspace = { id: 'workspace-1', licenseKey: 'secret' } as any;

    return { controller, spaceRepo, user, workspace };
  };

  it('returns apiAccess.personalSpaceId for API key authentication', async () => {
    const { controller, spaceRepo, user, workspace } = createSubject();
    const apiUser = withApiKeyAccess(user, {
      apiKeyId: 'key-1',
      personalSpaceId: 'personal-1',
    });

    const result = await controller.getUserInfo(apiUser, workspace);

    expect(result.personalSpaceId).toBe('personal-1');
    expect(result.apiAccess).toEqual({
      personalSpaceId: 'personal-1',
      policy: 'ordinary-user',
    });
    expect(result.workspace).not.toHaveProperty('licenseKey');
    expect(spaceRepo.findPersonalSpaceForUser).toHaveBeenCalledWith({
      userId: 'user-1',
      workspaceId: 'workspace-1',
    });
  });

  it('does not expose apiAccess for session authentication', async () => {
    const { controller, user, workspace } = createSubject();

    const result = await controller.getUserInfo(user, workspace);

    expect(result.personalSpaceId).toBe('personal-1');
    expect(result).not.toHaveProperty('apiAccess');
  });
});
