import { PagePermissionRepo } from '@akasha/db/repos/page/page-permission.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { UserRole } from '../../../common/helpers/types/permission';
import { SpaceAuthorizationService } from '../../../core/space/services/space-authorization.service';
import { KnowledgeSourceAuthorizationService } from './knowledge-source-authorization.service';

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
      filterReadableSpaceIds: jest.fn().mockResolvedValue(['space-1', 'space-3']),
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
});

function createService(overrides: {
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
} = {}) {
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
