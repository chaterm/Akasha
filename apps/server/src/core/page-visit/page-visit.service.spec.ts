import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PageVisitService } from './page-visit.service';
import { UserRole } from '../../common/helpers/types/permission';

describe('PageVisitService', () => {
  const page = {
    id: 'page-1',
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    deletedAt: null,
  };
  const user = { id: 'user-1', role: UserRole.MEMBER } as any;
  const workspace = { id: 'workspace-1' } as any;

  const createSubject = () => {
    const pageVisitRepo = {
      upsert: jest.fn(),
      findRecent: jest.fn().mockResolvedValue([]),
      deleteOlderThan: jest.fn().mockResolvedValue(0),
    };
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(page),
    };
    const pagePermissionRepo = {
      filterAccessiblePageIds: jest.fn().mockResolvedValue(['page-1']),
    };
    const pageAccessService = {
      validateCanView: jest.fn(),
    };
    const spaceAbility = {
      createForUser: jest.fn().mockResolvedValue({
        cannot: jest.fn().mockReturnValue(false),
      }),
    };
    const service = new PageVisitService(
      pageVisitRepo as any,
      pageRepo as any,
      pagePermissionRepo as any,
      pageAccessService as any,
      spaceAbility as any,
    );

    return {
      service,
      pageVisitRepo,
      pageRepo,
      pagePermissionRepo,
      pageAccessService,
      spaceAbility,
    };
  };

  it('records a real page view after checking current access', async () => {
    const { service, pageVisitRepo, pageAccessService } = createSubject();

    await service.record(page.id, user, workspace);

    expect(pageAccessService.validateCanView).toHaveBeenCalledWith(page, user);
    expect(pageVisitRepo.upsert).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      userId: user.id,
      pageId: page.id,
    });
  });

  it('does not record a page after access is denied', async () => {
    const { service, pageVisitRepo, pageAccessService } = createSubject();
    pageAccessService.validateCanView.mockRejectedValue(
      new ForbiddenException(),
    );

    await expect(service.record(page.id, user, workspace)).rejects.toThrow(
      ForbiddenException,
    );
    expect(pageVisitRepo.upsert).not.toHaveBeenCalled();
  });

  it('does not reveal pages from another workspace', async () => {
    const { service, pageRepo, pageVisitRepo } = createSubject();
    pageRepo.findById.mockResolvedValue({
      ...page,
      workspaceId: 'workspace-2',
    });

    await expect(service.record(page.id, user, workspace)).rejects.toThrow(
      NotFoundException,
    );
    expect(pageVisitRepo.upsert).not.toHaveBeenCalled();
  });

  it('filters recent visits using current space and page permissions', async () => {
    const { service, pageVisitRepo, pagePermissionRepo, spaceAbility } =
      createSubject();
    const visible = {
      id: 'visit-1',
      pageId: 'page-1',
      lastVisitedAt: new Date('2026-09-21T08:00:00.000Z'),
      title: 'Visible page',
      icon: null,
      slugId: 'visible-abc',
      spaceId: 'space-1',
      spaceName: 'Product',
      spaceSlug: 'product',
      spaceLogo: null,
    };
    const revoked = {
      ...visible,
      id: 'visit-2',
      pageId: 'page-2',
      title: 'Revoked page',
    };
    const removedSpace = {
      ...visible,
      id: 'visit-3',
      pageId: 'page-3',
      spaceId: 'space-2',
      title: 'Removed space page',
    };
    pageVisitRepo.findRecent.mockResolvedValue([
      visible,
      revoked,
      removedSpace,
    ]);
    spaceAbility.createForUser.mockImplementation(async (_user, spaceId) => ({
      cannot: jest.fn().mockReturnValue(spaceId === 'space-2'),
    }));
    pagePermissionRepo.filterAccessiblePageIds.mockResolvedValue(['page-1']);

    const result = await service.findRecent({
      user,
      workspace,
      limit: 15,
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        pageId: 'page-1',
        page: expect.objectContaining({ title: 'Visible page' }),
      }),
    ]);
    expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['page-1', 'page-2'],
      userId: 'user-1',
    });
  });

  it('queries only visits from the last 30 days', async () => {
    const { service, pageVisitRepo } = createSubject();
    jest.useFakeTimers().setSystemTime(new Date('2026-09-21T00:00:00.000Z'));

    try {
      await service.findRecent({
        user,
        workspace,
        spaceId: 'space-1',
        limit: 15,
      });
      expect(pageVisitRepo.findRecent).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'workspace-1',
          userId: 'user-1',
          spaceId: 'space-1',
          cutoff: new Date('2026-08-22T00:00:00.000Z'),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips spaces whose membership was revoked and keeps other readable visits', async () => {
    const { service, pageVisitRepo, spaceAbility, pagePermissionRepo } =
      createSubject();
    pageVisitRepo.findRecent.mockResolvedValue([
      visitRow('page-revoked-1', 'space-revoked'),
      visitRow('page-1', 'space-1'),
      visitRow('page-revoked-2', 'space-revoked'),
    ]);
    spaceAbility.createForUser.mockImplementation(async (_user, spaceId) => {
      if (spaceId === 'space-revoked') {
        throw new NotFoundException('Space permissions not found');
      }
      return { cannot: jest.fn().mockReturnValue(false) };
    });

    const result = await service.findRecent({ user, workspace, limit: 15 });

    expect(result.items.map((item) => item.pageId)).toEqual(['page-1']);
    expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['page-1'],
      userId: user.id,
      spaceId: undefined,
    });
    expect(spaceAbility.createForUser).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, 'space-revoked'])(
    'returns an empty list when no visited space is accessible (space filter: %s)',
    async (spaceId) => {
      const { service, pageVisitRepo, spaceAbility, pagePermissionRepo } =
        createSubject();
      pageVisitRepo.findRecent.mockResolvedValue([
        visitRow('page-revoked', 'space-revoked'),
      ]);
      spaceAbility.createForUser.mockRejectedValue(
        new NotFoundException('Space permissions not found'),
      );

      await expect(
        service.findRecent({ user, workspace, spaceId, limit: 15 }),
      ).resolves.toEqual({ items: [] });
      expect(pagePermissionRepo.filterAccessiblePageIds).not.toHaveBeenCalled();
    },
  );

  it('propagates unexpected failures during space permission checks', async () => {
    const { service, pageVisitRepo, spaceAbility, pagePermissionRepo } =
      createSubject();
    pageVisitRepo.findRecent.mockResolvedValue([visitRow('page-1', 'space-1')]);
    const error = new Error('Database connection failed');
    spaceAbility.createForUser.mockRejectedValue(error);

    await expect(
      service.findRecent({ user, workspace, limit: 15 }),
    ).rejects.toBe(error);
    expect(pagePermissionRepo.filterAccessiblePageIds).not.toHaveBeenCalled();
  });
});

function visitRow(pageId: string, spaceId: string) {
  return {
    id: `visit-${pageId}`,
    pageId,
    lastVisitedAt: new Date('2026-09-21T08:00:00.000Z'),
    title: `Title ${pageId}`,
    icon: null,
    slugId: pageId,
    spaceId,
    spaceName: spaceId,
    spaceSlug: spaceId,
    spaceLogo: null,
  };
}
