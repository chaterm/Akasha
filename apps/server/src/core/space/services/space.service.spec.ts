import { BadRequestException } from '@nestjs/common';
import { SpaceRole } from '../../../common/helpers/types/permission';
import { SpaceService } from './space.service';

jest.mock('@akasha/db/utils', () => ({
  executeTx: async (_db: unknown, callback: (trx: unknown) => unknown) =>
    callback({}),
}));

describe('SpaceService personal spaces', () => {
  const workspaceId = 'workspace-1';
  const user = {
    id: 'user-1',
    name: 'Fish',
    email: 'fish@example.com',
    avatarUrl: 'avatar.png',
  } as any;
  const trx = {} as any;

  function createService(overrides?: {
    existingSpace?: any;
    insertedSpace?: any;
  }) {
    const existingSpace = overrides?.existingSpace;
    const insertedSpace = overrides?.insertedSpace ?? {
      id: 'personal-1',
      personalOwnerId: user.id,
    };
    const service = Object.create(SpaceService.prototype) as any;
    service.spaceRepo = {
      findPersonalSpaceForUser: jest
        .fn()
        .mockResolvedValueOnce(existingSpace)
        .mockResolvedValue(insertedSpace),
      insertPersonalSpace: jest.fn().mockResolvedValue(insertedSpace),
      findById: jest.fn(),
    };
    service.spaceMemberService = {
      addUserToSpace: jest.fn().mockResolvedValue(undefined),
    };
    return service;
  }

  it('returns the explicitly owned personal space regardless of other memberships', async () => {
    const personalSpace = {
      id: 'personal-1',
      personalOwnerId: user.id,
    };
    const service = createService({ existingSpace: personalSpace });

    await expect(
      service.ensurePersonalSpace(user, workspaceId, trx),
    ).resolves.toBe(personalSpace);

    expect(service.spaceRepo.findPersonalSpaceForUser).toHaveBeenCalledWith({
      userId: user.id,
      workspaceId,
      trx,
    });
    expect(service.spaceRepo.insertPersonalSpace).not.toHaveBeenCalled();
    expect(service.spaceMemberService.addUserToSpace).not.toHaveBeenCalled();
  });

  it('creates a personal space with explicit ownership and admin membership', async () => {
    const service = createService();

    const result = await service.ensurePersonalSpace(user, workspaceId, trx);

    expect(service.spaceRepo.insertPersonalSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Fish(fish@example.com)',
        logo: 'avatar.png',
        creatorId: user.id,
        personalOwnerId: user.id,
        workspaceId,
      }),
      trx,
    );
    expect(service.spaceMemberService.addUserToSpace).toHaveBeenCalledWith(
      user.id,
      'personal-1',
      SpaceRole.ADMIN,
      workspaceId,
      trx,
    );
    expect(result.id).toBe('personal-1');
  });

  it('rejects deleting a personal space', async () => {
    const service = createService();
    service.spaceRepo.findById.mockResolvedValue({
      id: 'personal-1',
      personalOwnerId: user.id,
    });

    await expect(
      service.deleteSpace('personal-1', workspaceId),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('SpaceService compilation review settings', () => {
  it('persists the space compilation review opt-in under knowledge settings', async () => {
    const service = Object.create(SpaceService.prototype) as any;
    service.db = {};
    service.spaceRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'space-1',
        settings: {},
      }),
      updateKnowledgeSettings: jest.fn().mockResolvedValue(undefined),
      updateSpace: jest.fn().mockResolvedValue({
        id: 'space-1',
        settings: { knowledge: { compilationReviewEnabled: true } },
      }),
    };
    service.auditService = { log: jest.fn() };

    await service.updateSpace(
      { spaceId: 'space-1', enableCompilationReview: true },
      'workspace-1',
    );

    expect(service.spaceRepo.updateKnowledgeSettings).toHaveBeenCalledWith(
      'space-1',
      'workspace-1',
      'compilationReviewEnabled',
      true,
      {},
    );
  });
});
