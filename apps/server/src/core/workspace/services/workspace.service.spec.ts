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
});
