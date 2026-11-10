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

  it('records a space_deleted analytics event with the creation time', async () => {
    const service = createService();
    const createdAt = new Date('2026-01-02T03:04:05.000Z');
    service.spaceRepo.findById.mockResolvedValue({
      id: 'team-1',
      name: 'Team',
      personalOwnerId: null,
      createdAt,
    });
    service.spaceRepo.deleteSpace = jest.fn().mockResolvedValue(undefined);
    service.attachmentQueue = { add: jest.fn().mockResolvedValue(undefined) };
    service.auditService = { log: jest.fn() };
    service.analyticsEventRepo = {
      insertSpaceDeleted: jest.fn().mockResolvedValue(undefined),
    };

    await service.deleteSpace('team-1', workspaceId, user.id);

    expect(service.analyticsEventRepo.insertSpaceDeleted).toHaveBeenCalledWith(
      {
        workspaceId,
        userId: user.id,
        spaceId: 'team-1',
        spaceCreatedAt: createdAt,
        name: 'Team',
      },
    );
  });

  it('stores the Space-wide knowledge publish mode and audits the change', async () => {
    const service = createService();
    service.spaceRepo.findById.mockResolvedValue({
      id: 'team-1',
      settings: { knowledge: { indexMode: 'compiled' } },
    });
    service.spaceRepo.updateKnowledgeSettings = jest
      .fn()
      .mockResolvedValue(undefined);
    service.spaceRepo.updateSpace = jest
      .fn()
      .mockResolvedValue({ id: 'team-1' });
    service.auditService = { log: jest.fn() };

    await service.updateSpace(
      { spaceId: 'team-1', knowledgeIndexMode: 'original' },
      workspaceId,
    );

    expect(service.spaceRepo.updateKnowledgeSettings).toHaveBeenCalledWith(
      'team-1',
      workspaceId,
      'indexMode',
      'original',
      expect.anything(),
    );
    expect(service.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: {
          before: { knowledgeIndexMode: 'compiled' },
          after: { knowledgeIndexMode: 'original' },
        },
      }),
    );
  });
});
