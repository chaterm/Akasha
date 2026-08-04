import { PagePermissionRepo } from '@akasha/db/repos/page/page-permission.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { UserRole } from '../../../common/helpers/types/permission';
import { SpaceAuthorizationService } from '../../../core/space/services/space-authorization.service';
import { KnowledgeSourceAuthorizationService } from './knowledge-source-authorization.service';
import { KnowledgeAuthorizationCache } from './knowledge-source-authorization.cache';

describe('KnowledgeSourceAuthorizationService', () => {
  it('lets workspace owners read existing non-deleted sources only', async () => {
    const service = createService({
      pages: [
        pageRef('page-1', 'space-1'),
        pageRef('page-2', 'space-1', new Date('2026-01-01T00:00:00.000Z')),
      ],
      user: { id: 'owner-1', role: UserRole.OWNER, workspaceId: 'workspace-1' },
    });

    await expect(
      service.filterReadableSources({
        workspaceId: 'workspace-1',
        userId: 'owner-1',
        sourcePageIds: ['page-1', 'page-2', 'missing-page'],
      }),
    ).resolves.toEqual(['page-1']);
  });

  it('checks space readability before page restrictions for normal users', async () => {
    const pagePermissionRepo = {
      filterAccessiblePageIds: jest
        .fn()
        .mockResolvedValueOnce(['page-1'])
        .mockResolvedValueOnce(['page-3']),
    };
    const spaceAuthorization = {
      filterReadableSpaceIds: jest
        .fn()
        .mockResolvedValue(['space-1', 'space-3']),
    };
    const service = createService({
      pages: [
        pageRef('page-1', 'space-1'),
        pageRef('page-2', 'space-2'),
        pageRef('page-3', 'space-3'),
      ],
      pagePermissionRepo,
      spaceAuthorization,
      user: { id: 'user-1', role: UserRole.MEMBER, workspaceId: 'workspace-1' },
    });

    await expect(
      service.filterReadableSources({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        sourcePageIds: ['page-1', 'page-2', 'page-3'],
      }),
    ).resolves.toEqual(['page-1', 'page-3']);

    expect(spaceAuthorization.filterReadableSpaceIds).toHaveBeenCalledWith({
      user: { id: 'user-1', role: UserRole.MEMBER, workspaceId: 'workspace-1' },
      spaceIds: ['space-1', 'space-2', 'space-3'],
    });
    expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledTimes(2);
    expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['page-1'],
      userId: 'user-1',
      spaceId: 'space-1',
    });
    expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['page-3'],
      userId: 'user-1',
      spaceId: 'space-3',
    });
  });

  it('fails closed when a read-decision dependency throws', async () => {
    const service = createService({
      pageRepo: {
        findExistingPageRefs: jest.fn().mockRejectedValue(new Error('db down')),
      },
    });

    await expect(
      service.filterReadableSources({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        sourcePageIds: ['page-1'],
      }),
    ).resolves.toEqual([]);
  });

  describe('with a request-scoped cache', () => {
    it('memoizes readable and unreadable decisions across calls', async () => {
      const pagePermissionRepo = {
        filterAccessiblePageIds: jest.fn().mockResolvedValue(['page-1']),
      };
      const spaceAuthorization = {
        filterReadableSpaceIds: jest.fn().mockResolvedValue(['space-1']),
      };
      const pageRepo = {
        findExistingPageRefs: jest
          .fn()
          .mockResolvedValue([
            pageRef('page-1', 'space-1'),
            pageRef('page-2', 'space-1'),
          ]),
      };
      const userRepo = {
        findById: jest.fn().mockResolvedValue({
          id: 'user-1',
          role: UserRole.MEMBER,
          workspaceId: 'workspace-1',
        }),
      };
      const service = createService({
        pageRepo,
        userRepo,
        pagePermissionRepo,
        spaceAuthorization,
      });
      const cache = new KnowledgeAuthorizationCache({
        workspaceId: 'workspace-1',
        userId: 'user-1',
      });

      const first = await service.filterReadableSources({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        sourcePageIds: ['page-1', 'page-2'],
        cache,
      });
      const second = await service.filterReadableSources({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        sourcePageIds: ['page-1', 'page-2'],
        cache,
      });

      expect(first).toEqual(['page-1']);
      expect(second).toEqual(['page-1']);
      // Fully cached second pass hits no repository at all.
      expect(pageRepo.findExistingPageRefs).toHaveBeenCalledTimes(1);
      expect(userRepo.findById).toHaveBeenCalledTimes(1);
      expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledTimes(
        1,
      );
      expect(spaceAuthorization.filterReadableSpaceIds).toHaveBeenCalledTimes(
        1,
      );
    });

    it('caches OWNER and deleted-page decisions without re-querying', async () => {
      const pageRepo = {
        findExistingPageRefs: jest
          .fn()
          .mockResolvedValue([
            pageRef('page-1', 'space-1'),
            pageRef('page-2', 'space-1', new Date('2026-01-01T00:00:00.000Z')),
          ]),
      };
      const userRepo = {
        findById: jest.fn().mockResolvedValue({
          id: 'owner-1',
          role: UserRole.OWNER,
          workspaceId: 'workspace-1',
        }),
      };
      const service = createService({ pageRepo, userRepo });
      const cache = new KnowledgeAuthorizationCache({
        workspaceId: 'workspace-1',
        userId: 'owner-1',
      });

      const args = {
        workspaceId: 'workspace-1',
        userId: 'owner-1',
        sourcePageIds: ['page-1', 'page-2'],
        cache,
      };
      await expect(service.filterReadableSources(args)).resolves.toEqual([
        'page-1',
      ]);
      // page-2 (deleted) stays unreadable, page-1 stays readable — from cache.
      await expect(service.filterReadableSources(args)).resolves.toEqual([
        'page-1',
      ]);
      expect(pageRepo.findExistingPageRefs).toHaveBeenCalledTimes(1);
      expect(userRepo.findById).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failed computation and retries on the next call', async () => {
      const findExistingPageRefs = jest
        .fn()
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce([pageRef('page-1', 'space-1')]);
      const service = createService({
        pageRepo: { findExistingPageRefs },
        userRepo: {
          findById: jest.fn().mockResolvedValue({
            id: 'owner-1',
            role: UserRole.OWNER,
            workspaceId: 'workspace-1',
          }),
        },
      });
      const cache = new KnowledgeAuthorizationCache({
        workspaceId: 'workspace-1',
        userId: 'owner-1',
      });
      const args = {
        workspaceId: 'workspace-1',
        userId: 'owner-1',
        sourcePageIds: ['page-1'],
        cache,
      };

      // First call fails closed (dependency threw) and writes nothing.
      await expect(service.filterReadableSources(args)).resolves.toEqual([]);
      // Retry recomputes rather than serving a poisoned decision.
      await expect(service.filterReadableSources(args)).resolves.toEqual([
        'page-1',
      ]);
      expect(findExistingPageRefs).toHaveBeenCalledTimes(2);
    });

    it('fails closed when the cache scope does not match', async () => {
      const findExistingPageRefs = jest.fn();
      const service = createService({
        pageRepo: { findExistingPageRefs },
      });
      const cache = new KnowledgeAuthorizationCache({
        workspaceId: 'workspace-1',
        userId: 'user-1',
      });

      await expect(
        service.filterReadableSources({
          workspaceId: 'workspace-1',
          userId: 'attacker-2',
          sourcePageIds: ['page-1'],
          cache,
        }),
      ).resolves.toEqual([]);
      // Scope guard trips before any repository access.
      expect(findExistingPageRefs).not.toHaveBeenCalled();
    });

    it('preserves the input order of the requested source page ids', async () => {
      const service = createService({
        pages: [
          pageRef('page-1', 'space-1'),
          pageRef('page-2', 'space-1'),
          pageRef('page-3', 'space-1'),
        ],
        user: {
          id: 'owner-1',
          role: UserRole.OWNER,
          workspaceId: 'workspace-1',
        },
      });
      const cache = new KnowledgeAuthorizationCache({
        workspaceId: 'workspace-1',
        userId: 'owner-1',
      });

      await expect(
        service.filterReadableSources({
          workspaceId: 'workspace-1',
          userId: 'owner-1',
          sourcePageIds: ['page-3', 'page-1', 'page-2'],
          cache,
        }),
      ).resolves.toEqual(['page-3', 'page-1', 'page-2']);
    });

    it('accepts single-request snapshot semantics: one cache freezes a decision, a new cache reflects changes', async () => {
      const filterAccessiblePageIds = jest
        .fn()
        .mockResolvedValueOnce(['page-1']) // initially readable
        .mockResolvedValueOnce([]); // permission later revoked
      const service = createService({
        pages: [pageRef('page-1', 'space-1')],
        pagePermissionRepo: { filterAccessiblePageIds },
        spaceAuthorization: {
          filterReadableSpaceIds: jest.fn().mockResolvedValue(['space-1']),
        },
        user: {
          id: 'user-1',
          role: UserRole.MEMBER,
          workspaceId: 'workspace-1',
        },
      });
      const args = {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        sourcePageIds: ['page-1'],
      };

      const firstCache = new KnowledgeAuthorizationCache({
        workspaceId: 'workspace-1',
        userId: 'user-1',
      });
      await expect(
        service.filterReadableSources({ ...args, cache: firstCache }),
      ).resolves.toEqual(['page-1']);
      // Same cache: decision is frozen for the request, permission repo not re-hit.
      await expect(
        service.filterReadableSources({ ...args, cache: firstCache }),
      ).resolves.toEqual(['page-1']);
      expect(filterAccessiblePageIds).toHaveBeenCalledTimes(1);

      // A new request (new cache) observes the revoked permission.
      const secondCache = new KnowledgeAuthorizationCache({
        workspaceId: 'workspace-1',
        userId: 'user-1',
      });
      await expect(
        service.filterReadableSources({ ...args, cache: secondCache }),
      ).resolves.toEqual([]);
      expect(filterAccessiblePageIds).toHaveBeenCalledTimes(2);
    });
  });
});

function createService(
  overrides: {
    pages?: Array<{
      id: string;
      workspaceId: string;
      spaceId: string;
      deletedAt: Date | null;
    }>;
    user?: { id: string; role: string; workspaceId: string };
    pageRepo?: Partial<PageRepo>;
    userRepo?: Partial<UserRepo>;
    pagePermissionRepo?: Partial<PagePermissionRepo>;
    spaceAuthorization?: Partial<SpaceAuthorizationService>;
  } = {},
) {
  const pageRepo = {
    findExistingPageRefs: jest.fn().mockResolvedValue(overrides.pages ?? []),
    ...overrides.pageRepo,
  };
  const userRepo = {
    findById: jest.fn().mockResolvedValue(
      overrides.user ?? {
        id: 'user-1',
        role: UserRole.MEMBER,
        workspaceId: 'workspace-1',
      },
    ),
    ...overrides.userRepo,
  };
  const pagePermissionRepo = {
    filterAccessiblePageIds: jest.fn().mockResolvedValue([]),
    ...overrides.pagePermissionRepo,
  };
  const spaceAuthorization = {
    filterReadableSpaceIds: jest.fn().mockResolvedValue([]),
    ...overrides.spaceAuthorization,
  };

  return new KnowledgeSourceAuthorizationService(
    pageRepo as unknown as PageRepo,
    userRepo as unknown as UserRepo,
    pagePermissionRepo as unknown as PagePermissionRepo,
    spaceAuthorization as unknown as SpaceAuthorizationService,
  );
}

function pageRef(id: string, spaceId: string, deletedAt: Date | null = null) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId,
    deletedAt,
  };
}
