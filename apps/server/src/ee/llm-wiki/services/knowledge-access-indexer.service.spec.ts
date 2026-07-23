import { KnowledgeAccessPolicyRepo } from '@akasha/db/repos/llm-wiki/knowledge-access-policy.repo';
import { PagePermissionRepo } from '@akasha/db/repos/page/page-permission.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { KnowledgeAccessIndexerService } from './knowledge-access-indexer.service';

describe('KnowledgeAccessIndexerService', () => {
  it('indexes restricted ancestors and allowed principals without expanding groups', async () => {
    const accessPolicyRepo = {
      replacePolicySnapshot: jest.fn(),
    };
    const service = createService({
      accessPolicyRepo,
      pages: [
        pageRef('page-1', 'space-1'),
        pageRef('page-2', 'space-1'),
      ],
      restrictedRequirements: [
        {
          sourcePageId: 'page-1',
          sourceSpaceId: 'space-1',
          restrictedAncestors: [
            {
              pageAccessId: 'access-1',
              restrictedPageId: 'restricted-1',
              depth: 0,
              permissions: [
                { userId: 'user-1', groupId: null, role: 'reader' },
                { userId: null, groupId: 'group-1', role: 'writer' },
              ],
            },
            {
              pageAccessId: 'access-empty',
              restrictedPageId: 'restricted-empty',
              depth: 1,
              permissions: [],
            },
          ],
        },
      ],
    });

    await expect(
      service.reindexSourcePages({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1', 'page-2'],
      }),
    ).resolves.toEqual({ indexedCount: 2 });

    expect(accessPolicyRepo.replacePolicySnapshot).toHaveBeenCalledTimes(2);
    expect(accessPolicyRepo.replacePolicySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        sourcePageId: 'page-1',
        sourceSpaceId: 'space-1',
        restrictedAncestorCount: 2,
        policyHash: expect.stringMatching(/^sha256:/),
        requirements: [
          {
            requirementId: 'access-1',
            restrictedPageId: 'restricted-1',
            depth: 0,
            principals: [
              {
                principalType: 'group',
                principalId: 'group-1',
                role: 'writer',
              },
              {
                principalType: 'user',
                principalId: 'user-1',
                role: 'reader',
              },
            ],
          },
          {
            requirementId: 'access-empty',
            restrictedPageId: 'restricted-empty',
            depth: 1,
            principals: [],
          },
        ],
      }),
    );
    expect(accessPolicyRepo.replacePolicySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        sourcePageId: 'page-2',
        sourceSpaceId: 'space-1',
        restrictedAncestorCount: 0,
        requirements: [],
      }),
    );
  });

  it('drops deleted or missing pages before computing requirements', async () => {
    const pagePermissionRepo = {
      findRestrictedAncestorRequirementsForPages: jest.fn().mockResolvedValue([]),
    };
    const accessPolicyRepo = {
      replacePolicySnapshot: jest.fn(),
    };
    const service = createService({
      accessPolicyRepo,
      pagePermissionRepo,
      pages: [
        pageRef('page-1', 'space-1'),
        pageRef('deleted-page', 'space-1', new Date('2026-06-16T00:00:00.000Z')),
      ],
    });

    await expect(
      service.reindexSourcePages({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1', 'deleted-page', 'missing-page'],
      }),
    ).resolves.toEqual({ indexedCount: 1 });

    expect(
      pagePermissionRepo.findRestrictedAncestorRequirementsForPages,
    ).toHaveBeenCalledWith(['page-1']);
    expect(accessPolicyRepo.replacePolicySnapshot).toHaveBeenCalledTimes(1);
  });

  it('marks a scope stale when exact affected source pages are unknown', async () => {
    const accessPolicyRepo = {
      markScopeStale: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService({ accessPolicyRepo });

    await service.markScopeStale({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });

    expect(accessPolicyRepo.markScopeStale).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
  });
});

function createService(overrides: {
  pages?: Array<{
    id: string;
    workspaceId: string;
    spaceId: string;
    deletedAt: Date | null;
  }>;
  restrictedRequirements?: Array<{
    sourcePageId: string;
    sourceSpaceId: string;
    restrictedAncestors: Array<{
      pageAccessId: string;
      restrictedPageId: string;
      depth: number;
      permissions: Array<{
        userId: string | null;
        groupId: string | null;
        role: string;
      }>;
    }>;
  }>;
  pageRepo?: Partial<PageRepo>;
  pagePermissionRepo?: Partial<PagePermissionRepo>;
  accessPolicyRepo?: Partial<KnowledgeAccessPolicyRepo>;
} = {}) {
  const pageRepo = {
    findExistingPageRefs: jest.fn().mockResolvedValue(overrides.pages ?? []),
    ...overrides.pageRepo,
  };
  const pagePermissionRepo = {
    findRestrictedAncestorRequirementsForPages: jest
      .fn()
      .mockResolvedValue(overrides.restrictedRequirements ?? []),
    ...overrides.pagePermissionRepo,
  };
  const accessPolicyRepo = {
    replacePolicySnapshot: jest.fn(),
    markScopeStale: jest.fn(),
    ...overrides.accessPolicyRepo,
  };

  return new KnowledgeAccessIndexerService(
    pageRepo as unknown as PageRepo,
    pagePermissionRepo as unknown as PagePermissionRepo,
    accessPolicyRepo as unknown as KnowledgeAccessPolicyRepo,
  );
}

function pageRef(
  id: string,
  spaceId: string,
  deletedAt: Date | null = null,
) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId,
    deletedAt,
  };
}
