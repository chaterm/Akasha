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

  it('returns a Skill update notice when the API key client is older', async () => {
    const { controller, user, workspace } = createSubject();
    workspace.settings = {
      ai: {
        skill: {
          latestVersion: '1.10.0',
          upgradeUrl: 'https://example.com/akasha-skill',
        },
      },
    };
    const apiUser = withApiKeyAccess(user, {
      apiKeyId: 'key-1',
      personalSpaceId: 'personal-1',
    });

    const result = await (controller.getUserInfo as any)(
      apiUser,
      workspace,
      '1.9.0',
    );

    expect(result.skillUpdateNotice).toEqual({
      currentVersion: '1.9.0',
      latestVersion: '1.10.0',
      message:
        '当前 Akasha Skill 版本为 1.9.0，低于最新版 1.10.0。请在完成当前请求后提示用户升级 Akasha Skill；未经用户确认不要自动升级。',
      upgradeUrl: 'https://example.com/akasha-skill',
    });
  });

  it.each(['1.10.0', '1.11.0', '2.0.0'])(
    'does not return a Skill update notice for version %s',
    async (skillVersion) => {
      const { controller, user, workspace } = createSubject();
      workspace.settings = {
        ai: {
          skill: {
            latestVersion: '1.10.0',
            upgradeUrl: 'https://example.com/akasha-skill',
          },
        },
      };
      const apiUser = withApiKeyAccess(user, {
        apiKeyId: 'key-1',
        personalSpaceId: 'personal-1',
      });

      const result = await (controller.getUserInfo as any)(
        apiUser,
        workspace,
        skillVersion,
      );

      expect(result).not.toHaveProperty('skillUpdateNotice');
    },
  );

  it('does not return a Skill update notice before the server is configured', async () => {
    const { controller, user, workspace } = createSubject();
    const apiUser = withApiKeyAccess(user, {
      apiKeyId: 'key-1',
      personalSpaceId: 'personal-1',
    });

    const result = await (controller.getUserInfo as any)(
      apiUser,
      workspace,
      '1.0.0',
    );

    expect(result).not.toHaveProperty('skillUpdateNotice');
  });

  it('compares semantic version segments without numeric precision loss', async () => {
    const { controller, user, workspace } = createSubject();
    workspace.settings = {
      ai: {
        skill: {
          latestVersion: '9007199254740993.0.0',
          upgradeUrl: 'https://example.com/akasha-skill',
        },
      },
    };
    const apiUser = withApiKeyAccess(user, {
      apiKeyId: 'key-1',
      personalSpaceId: 'personal-1',
    });

    const result = await (controller.getUserInfo as any)(
      apiUser,
      workspace,
      '9007199254740992.0.0',
    );

    expect(result.skillUpdateNotice).toEqual(
      expect.objectContaining({
        currentVersion: '9007199254740992.0.0',
        latestVersion: '9007199254740993.0.0',
      }),
    );
  });
});
