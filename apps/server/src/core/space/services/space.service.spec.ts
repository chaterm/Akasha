import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SpaceRole, UserRole } from '../../../common/helpers/types/permission';
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

  it('marks newly created spaces as personal only when requested', async () => {
    const service = Object.create(SpaceService.prototype) as any;
    service.spaceRepo = {
      slugExists: jest.fn().mockResolvedValue(false),
      insertSpace: jest.fn().mockResolvedValue({ id: 'space-1' }),
    };

    await service.create(user.id, workspaceId, {
      name: 'Notes',
      slug: 'notes',
      type: 'personal',
    });

    expect(service.spaceRepo.insertSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        creatorId: user.id,
        personalOwnerId: user.id,
        workspaceId,
      }),
      undefined,
    );
  });

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
      lockPersonalSpacesForUser: jest.fn().mockResolvedValue(undefined),
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

  it.each(['personal', 'public'] as const)(
    'creates a %s space with admin membership and no automatic favorite',
    async (type) => {
      const service = createService();
      service.create = jest.fn().mockResolvedValue({ id: 'space-1' });
      service.favoriteRepo = { insert: jest.fn() };
      service.auditService = { log: jest.fn() };

      await service.createSpace(user, workspaceId, {
        name: 'Notes',
        slug: 'notes',
        type,
      });

      expect(service.spaceMemberService.addUserToSpace).toHaveBeenCalledWith(
        user.id,
        'space-1',
        SpaceRole.ADMIN,
        workspaceId,
        expect.anything(),
      );
      expect(service.favoriteRepo.insert).not.toHaveBeenCalled();
    },
  );

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

  it.each([
    { id: user.id, role: UserRole.MEMBER },
    { id: 'workspace-admin', role: UserRole.ADMIN },
    { id: 'workspace-owner', role: UserRole.OWNER },
  ])('rejects deleting a default personal space by %j', async (actor) => {
    const service = createService();
    service.spaceRepo.findById.mockResolvedValue({
      id: 'personal-1',
      personalOwnerId: user.id,
      isDefaultPersonal: true,
    });

    await expect(
      service.deleteSpace('personal-1', workspaceId, actor),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects deleting another user’s self-created space by a workspace member', async () => {
    const service = createService();
    service.spaceRepo.findById.mockResolvedValue({
      id: 'personal-1',
      creatorId: user.id,
      personalOwnerId: user.id,
      isDefaultPersonal: false,
    });

    await expect(
      service.deleteSpace('personal-1', workspaceId, {
        id: 'another-user',
        role: UserRole.MEMBER,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it.each([
    { personalOwnerId: null, actor: { id: user.id, role: UserRole.MEMBER } },
    { personalOwnerId: user.id, actor: { id: user.id, role: UserRole.MEMBER } },
    {
      personalOwnerId: user.id,
      actor: { id: 'workspace-admin', role: UserRole.ADMIN },
    },
  ])(
    'records deletion analytics for %j',
    async ({ personalOwnerId, actor }) => {
      const service = createService();
      const createdAt = new Date('2026-01-02T03:04:05.000Z');
      service.spaceRepo.findById.mockResolvedValue({
        id: 'team-1',
        name: 'Team',
        creatorId: user.id,
        personalOwnerId,
        isDefaultPersonal: false,
        createdAt,
      });
      service.spaceRepo.deleteSpace = jest.fn().mockResolvedValue(undefined);
      service.attachmentQueue = { add: jest.fn().mockResolvedValue(undefined) };
      service.auditService = { log: jest.fn() };
      service.analyticsEventRepo = {
        insertSpaceDeleted: jest.fn().mockResolvedValue(undefined),
      };

      await service.deleteSpace('team-1', workspaceId, actor);

      expect(
        service.analyticsEventRepo.insertSpaceDeleted,
      ).toHaveBeenCalledWith({
        workspaceId,
        userId: actor.id,
        spaceId: 'team-1',
        spaceCreatedAt: createdAt,
        name: 'Team',
      });
    },
  );

  it.each([
    { personalOwnerId: null, isDefaultPersonal: false },
    { personalOwnerId: 'another-user', isDefaultPersonal: false },
  ])('stores and audits the space-wide publish mode for %j', async (space) => {
    const service = createService();
    service.spaceRepo.findById.mockResolvedValue({
      id: 'team-1',
      ...space,
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
