import { WorkspaceService } from './workspace.service';

describe('WorkspaceService', () => {
  it('shows the env-configured HOIDC provider on the first database workspace', async () => {
    const workspace = {
      id: 'workspace-from-db',
      name: 'Akasha',
      logo: null,
      hostname: null,
      enforceSso: false,
      licenseKey: null,
      plan: null,
      authProviders: [],
    };
    const db = {
      selectFrom: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      executeTakeFirst: jest.fn().mockResolvedValue(workspace),
    };
    const service = Object.create(WorkspaceService.prototype) as any;
    service.db = db;
    service.workspaceRepo = {
      findFirst: jest.fn().mockResolvedValue({ id: 'workspace-from-db' }),
    };
    service.environmentService = {
      getHoidcSsoApi: jest.fn(() => 'https://sso.example.com'),
      getHoidcPlatformId: jest.fn(() => 'platform-1'),
    };

    const result = await service.getWorkspacePublicData('workspace-from-db');

    expect(service.workspaceRepo.findFirst).toHaveBeenCalledTimes(1);
    expect(result.authProviders).toContainEqual({
      id: 'hoidc-env',
      name: 'SSO Login',
      type: 'hoidc',
    });
  });

  it('keeps the personal-space owner membership when deleting a workspace user', async () => {
    const trx = {
      deleteFrom: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const service = Object.create(WorkspaceService.prototype) as any;
    service.db = {
      transaction: jest.fn(() => ({
        execute: (callback: (activeTrx: typeof trx) => Promise<void>) =>
          callback(trx),
      })),
    };
    service.userRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'user-1',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'member',
        deletedAt: null,
      }),
      roleCountByWorkspaceId: jest.fn().mockResolvedValue(1),
      updateUser: jest.fn().mockResolvedValue(undefined),
    };
    service.spaceMemberService = {
      removeUserFromNonPersonalSpaces: jest.fn().mockResolvedValue(undefined),
    };
    service.watcherRepo = {
      deleteByUserAndWorkspace: jest.fn().mockResolvedValue(undefined),
    };
    service.favoriteRepo = {
      deleteByUserAndWorkspace: jest.fn().mockResolvedValue(undefined),
    };
    service.userSessionRepo = {
      revokeByUserId: jest.fn().mockResolvedValue(undefined),
    };
    service.auditService = { log: jest.fn() };
    service.attachmentQueue = { add: jest.fn().mockResolvedValue(undefined) };

    await service.deleteUser(
      { id: 'admin-1', role: 'owner' },
      'user-1',
      'workspace-1',
    );

    expect(
      service.spaceMemberService.removeUserFromNonPersonalSpaces,
    ).toHaveBeenCalledWith('user-1', 'workspace-1', trx);
    expect(trx.deleteFrom).not.toHaveBeenCalledWith('spaceMembers');
  });

  it('reads Akasha Skill release settings from the workspace', async () => {
    const workspaceRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'workspace-1',
        settings: {
          ai: {
            skill: {
              latestVersion: '1.0.0',
              upgradeUrl: 'https://example.com/akasha-skill',
            },
          },
        },
      }),
    };
    const service = Object.create(WorkspaceService.prototype) as any;
    service.workspaceRepo = workspaceRepo;

    await expect(service.getSkillSettings('workspace-1')).resolves.toEqual({
      latestVersion: '1.0.0',
      upgradeUrl: 'https://example.com/akasha-skill',
    });
  });

  it('replaces invalid legacy Skill settings with the two saved fields', async () => {
    const workspaceRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'workspace-1',
        settings: { ai: { skill: [{}, '{"latestVersion":"1.0.0"}'] } },
      }),
      updateAiSkillSettings: jest.fn().mockResolvedValue(undefined),
    };
    const service = Object.create(WorkspaceService.prototype) as any;
    service.workspaceRepo = workspaceRepo;
    service.auditService = { log: jest.fn() };

    await expect(
      service.updateSkillSettings('workspace-1', {
        latestVersion: '1.1.0',
        upgradeUrl: 'https://example.com/akasha-skill',
      }),
    ).resolves.toEqual({
      latestVersion: '1.1.0',
      upgradeUrl: 'https://example.com/akasha-skill',
    });

    expect(workspaceRepo.updateAiSkillSettings).toHaveBeenCalledWith(
      'workspace-1',
      {
        latestVersion: '1.1.0',
        upgradeUrl: 'https://example.com/akasha-skill',
      },
    );
    expect(service.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: {
          before: { latestVersion: '', upgradeUrl: '' },
          after: {
            latestVersion: '1.1.0',
            upgradeUrl: 'https://example.com/akasha-skill',
          },
        },
      }),
    );
  });
});
