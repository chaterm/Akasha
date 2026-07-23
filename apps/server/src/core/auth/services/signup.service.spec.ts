import { SignupService } from './signup.service';

describe('SignupService personal-space provisioning', () => {
  const trx = {} as any;
  const db = {
    transaction: jest.fn(() => ({
      execute: (callback: (trx: any) => unknown) => callback(trx),
    })),
  };

  function createService() {
    const user = {
      id: 'user-1',
      name: 'Fish',
      email: 'fish@example.com',
      workspaceId: 'workspace-1',
    };
    const service = Object.create(SignupService.prototype) as any;
    service.db = db;
    service.userRepo = {
      findByEmail: jest.fn().mockResolvedValue(undefined),
      insertUser: jest.fn().mockResolvedValue(user),
    };
    service.workspaceService = {
      addUserToWorkspace: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue({ id: 'workspace-1' }),
    };
    service.groupUserRepo = {
      addUserToDefaultGroup: jest.fn().mockResolvedValue(undefined),
    };
    service.spaceService = {
      ensurePersonalSpace: jest.fn().mockResolvedValue({ id: 'personal-1' }),
    };
    service.auditService = { log: jest.fn() };
    return { service, user };
  }

  it('creates the personal space in the signup transaction', async () => {
    const { service, user } = createService();

    await service.signup(
      {
        name: user.name,
        email: user.email,
        password: 'secret',
      },
      'workspace-1',
    );

    expect(service.spaceService.ensurePersonalSpace).toHaveBeenCalledWith(
      user,
      'workspace-1',
      trx,
    );
  });

  it('creates the initial owner personal space in the workspace transaction', async () => {
    const { service, user } = createService();

    await service.initialSetup({
      name: user.name,
      email: user.email,
      password: 'secret',
      workspaceName: 'Akasha',
    });

    expect(service.spaceService.ensurePersonalSpace).toHaveBeenCalledWith(
      expect.objectContaining({ id: user.id, workspaceId: 'workspace-1' }),
      'workspace-1',
      trx,
    );
  });
});
