import { createHash } from 'node:crypto';
import { ReviewApplyService } from './review-apply.service';

jest.mock('../../../core/page/services/page.service', () => ({
  PageService: class PageService {},
}));

jest.mock('../../../collaboration/collaboration.util', () => ({
  jsonToMarkdown: jest.fn((value: unknown) => {
    if (typeof value === 'string') return value;
    if (
      typeof value === 'object' &&
      value !== null &&
      'markdown' in value &&
      typeof value.markdown === 'string'
    ) {
      return value.markdown;
    }
    return '';
  }),
}));

describe('ReviewApplyService', () => {
  it('plans append-section without changing the page title', async () => {
    const before = 'Existing content';
    const applicationRepo = {
      insertApplication: jest.fn().mockImplementation((input) =>
        Promise.resolve(
          applicationRow({
            ...input,
            createdAt: new Date('2026-06-22T10:00:00.000Z'),
            updatedAt: new Date('2026-06-22T10:00:00.000Z'),
          }),
        ),
      ),
    };
    const page = pageRow({
      title: 'Operations',
      content: { markdown: before },
    });
    const service = new ReviewApplyService(
      {} as any,
      { findById: jest.fn().mockResolvedValue(page) } as any,
      { validateCanEdit: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      applicationRepo as any,
    );

    await expect(
      service.planDraft({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        user: { id: 'user-1' } as any,
        item: {
          id: 'rev-1',
          type: 'suggestion',
          title: 'Add SLO details',
          detail: 'Missing details',
          recommendation: 'Append SLO details',
          relatedDocIds: ['kp-1'],
          searchQueries: [],
          targetDocId: 'kp-1',
        },
        draft: {
          title: 'SLO details',
          body: 'Latency target and burn-rate alerts.',
          approach: 'section',
          applyOperation: 'append-section',
          targetDocId: 'kp-1',
          notes: '',
        },
        docs: [{ id: 'kp-1', title: 'Operations', sourcePageId: 'page-1' }],
      }),
    ).resolves.toMatchObject({
      operation: 'append_section',
      targetPageTitle: 'Operations',
      afterContent:
        'Existing content\n\n## SLO details\n\nLatency target and burn-rate alerts.',
      patch: expect.objectContaining({
        applyOperation: 'append-section',
        proposedPageTitle: null,
      }),
    });

    expect(applicationRepo.insertApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'append_section',
        targetPageTitle: 'Operations',
        targetHeadingPath: [],
      }),
    );
  });

  it('applies rename-page by updating only the page title', async () => {
    const before = 'Existing content';
    const application = applicationRow({
      operation: 'rename_page',
      baseContentHash: hashContent(before),
      beforeContent: before,
      afterContent: before,
      afterContentHash: hashContent(before),
      patch: {
        applyOperation: 'rename-page',
        originalPageTitle: 'Old title',
        proposedPageTitle: 'New title',
      },
    });
    const applicationRepo = {
      findById: jest.fn().mockResolvedValue(application),
      updateApplication: jest.fn().mockImplementation(({ patch }) =>
        Promise.resolve({
          ...application,
          ...patch,
          updatedAt: new Date('2026-06-22T10:00:01.000Z'),
        }),
      ),
    };
    const page = pageRow({
      title: 'Old title',
      content: { markdown: before },
      updatedAt: new Date('2026-06-22T10:00:00.000Z'),
    });
    const pageService = {
      update: jest.fn().mockResolvedValue(
        pageRow({
          title: 'New title',
          content: { markdown: before },
          updatedAt: new Date('2026-06-22T10:00:01.000Z'),
        }),
      ),
    };
    const service = new ReviewApplyService(
      pageService as any,
      { findById: jest.fn().mockResolvedValue(page) } as any,
      { validateCanEdit: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      applicationRepo as any,
    );

    await expect(
      service.applyApplication({
        workspaceId: 'workspace-1',
        user: { id: 'user-1' } as any,
        applicationId: 'app-1',
      }),
    ).resolves.toMatchObject({
      status: 'applied',
      targetPageTitle: 'New title',
      afterContent: before,
      afterContentHash: hashContent(before),
    });

    expect(pageService.update).toHaveBeenCalledWith(
      page,
      {
        pageId: 'page-1',
        title: 'New title',
      },
      expect.objectContaining({ id: 'user-1' }),
    );
  });

  it('applies a planned page title change and records the stored markdown hash', async () => {
    const before = 'Before content';
    const plannedAfter = 'Planned after content';
    const storedAfter = 'Stored after content';
    const application = applicationRow({
      baseContentHash: hashContent(before),
      beforeContent: before,
      afterContent: plannedAfter,
      afterContentHash: hashContent(plannedAfter),
      patch: {
        originalPageTitle: 'Old title',
        proposedPageTitle: 'New title',
      },
    });
    const applicationRepo = {
      findById: jest.fn().mockResolvedValue(application),
      updateApplication: jest.fn().mockImplementation(({ patch }) =>
        Promise.resolve({
          ...application,
          ...patch,
          updatedAt: new Date('2026-06-22T10:00:01.000Z'),
        }),
      ),
    };
    const page = pageRow({
      title: 'Old title',
      content: { markdown: before },
      updatedAt: new Date('2026-06-22T10:00:00.000Z'),
    });
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(page),
    };
    const pageService = {
      update: jest.fn().mockResolvedValue(
        pageRow({
          title: 'New title',
          content: { markdown: storedAfter },
          updatedAt: new Date('2026-06-22T10:00:01.000Z'),
        }),
      ),
    };
    const service = new ReviewApplyService(
      pageService as any,
      pageRepo as any,
      { validateCanEdit: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      applicationRepo as any,
    );

    await expect(
      service.applyApplication({
        workspaceId: 'workspace-1',
        user: { id: 'user-1' } as any,
        applicationId: 'app-1',
      }),
    ).resolves.toMatchObject({
      status: 'applied',
      targetPageTitle: 'New title',
      afterContent: storedAfter,
      afterContentHash: hashContent(storedAfter),
    });

    expect(pageService.update).toHaveBeenCalledWith(
      page,
      expect.objectContaining({
        title: 'New title',
        content: plannedAfter,
        operation: 'replace',
        format: 'markdown',
      }),
      expect.objectContaining({ id: 'user-1' }),
    );
    expect(applicationRepo.updateApplication).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      id: 'app-1',
      patch: expect.objectContaining({
        status: 'applied',
        targetPageTitle: 'New title',
        afterContent: storedAfter,
        afterContentHash: hashContent(storedAfter),
      }),
    });
  });

  it('reverts an applied page when only markdown normalization differs', async () => {
    const before = 'Before content';
    const plannedAfter = 'After content\n\n';
    const storedAfter = 'After content';
    const application = applicationRow({
      status: 'applied',
      baseContentHash: hashContent(before),
      beforeContent: before,
      afterContent: plannedAfter,
      afterContentHash: hashContent(plannedAfter),
      appliedAt: new Date('2026-06-22T10:00:01.000Z'),
      patch: {
        originalPageTitle: 'Old title',
        proposedPageTitle: 'New title',
      },
      targetPageTitle: 'New title',
    });
    const applicationRepo = {
      findById: jest.fn().mockResolvedValue(application),
      updateApplication: jest.fn().mockImplementation(({ patch }) =>
        Promise.resolve({
          ...application,
          ...patch,
          updatedAt: new Date('2026-06-22T10:00:02.000Z'),
        }),
      ),
    };
    const page = pageRow({
      title: 'New title',
      content: { markdown: storedAfter },
      updatedAt: new Date('2026-06-22T10:00:01.000Z'),
    });
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(page),
    };
    const pageService = {
      update: jest.fn().mockResolvedValue(
        pageRow({
          title: 'Old title',
          content: { markdown: before },
          updatedAt: new Date('2026-06-22T10:00:02.000Z'),
        }),
      ),
    };
    const service = new ReviewApplyService(
      pageService as any,
      pageRepo as any,
      { validateCanEdit: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      applicationRepo as any,
    );

    await expect(
      service.revertApplication({
        workspaceId: 'workspace-1',
        user: { id: 'user-1' } as any,
        applicationId: 'app-1',
      }),
    ).resolves.toMatchObject({
      status: 'reverted',
      targetPageTitle: 'Old title',
    });

    expect(pageService.update).toHaveBeenCalledWith(
      page,
      expect.objectContaining({
        title: 'Old title',
        content: before,
        operation: 'replace',
      }),
      expect.objectContaining({ id: 'user-1' }),
    );
    expect(applicationRepo.updateApplication).not.toHaveBeenCalledWith(
      expect.objectContaining({
        patch: { status: 'conflicted' },
      }),
    );
  });

  it('allows retrying a conflicted revert when the page still matches the applied content', async () => {
    const before = 'Before content';
    const after = 'After content';
    const application = applicationRow({
      status: 'conflicted',
      beforeContent: before,
      afterContent: after,
      afterContentHash: hashContent(after),
      appliedAt: new Date('2026-06-22T10:00:01.000Z'),
      targetPageTitle: 'New title',
      patch: {
        originalPageTitle: 'Old title',
        proposedPageTitle: 'New title',
      },
    });
    const applicationRepo = {
      findById: jest.fn().mockResolvedValue(application),
      updateApplication: jest.fn().mockImplementation(({ patch }) =>
        Promise.resolve({
          ...application,
          ...patch,
          updatedAt: new Date('2026-06-22T10:00:03.000Z'),
        }),
      ),
    };
    const page = pageRow({
      title: 'New title',
      content: { markdown: after },
      updatedAt: new Date('2026-06-22T10:00:02.000Z'),
    });
    const pageService = {
      update: jest.fn().mockResolvedValue(
        pageRow({
          title: 'Old title',
          content: { markdown: before },
          updatedAt: new Date('2026-06-22T10:00:03.000Z'),
        }),
      ),
    };
    const service = new ReviewApplyService(
      pageService as any,
      { findById: jest.fn().mockResolvedValue(page) } as any,
      { validateCanEdit: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      applicationRepo as any,
    );

    await expect(
      service.revertApplication({
        workspaceId: 'workspace-1',
        user: { id: 'user-1' } as any,
        applicationId: 'app-1',
      }),
    ).resolves.toMatchObject({
      status: 'reverted',
      targetPageTitle: 'Old title',
    });
  });

  it('infers a title change for legacy whole-page replacement applications', async () => {
    const before = 'Before content';
    const after = '# Legacy new title\n\nAfter content';
    const application = applicationRow({
      baseContentHash: hashContent(before),
      beforeContent: before,
      afterContent: after,
      afterContentHash: hashContent(after),
      patch: {
        draftTitle: 'Legacy new title',
        targetHeadingPath: [],
        strategy: 'replace_page_content_when_no_heading_matched',
      },
    });
    const applicationRepo = {
      findById: jest.fn().mockResolvedValue(application),
      updateApplication: jest.fn().mockImplementation(({ patch }) =>
        Promise.resolve({
          ...application,
          ...patch,
          updatedAt: new Date('2026-06-22T10:00:01.000Z'),
        }),
      ),
    };
    const page = pageRow({
      title: 'Old title',
      content: { markdown: before },
      updatedAt: new Date('2026-06-22T10:00:00.000Z'),
    });
    const pageService = {
      update: jest.fn().mockResolvedValue(
        pageRow({
          title: 'Legacy new title',
          content: { markdown: after },
          updatedAt: new Date('2026-06-22T10:00:01.000Z'),
        }),
      ),
    };
    const service = new ReviewApplyService(
      pageService as any,
      { findById: jest.fn().mockResolvedValue(page) } as any,
      { validateCanEdit: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      applicationRepo as any,
    );

    await expect(
      service.applyApplication({
        workspaceId: 'workspace-1',
        user: { id: 'user-1' } as any,
        applicationId: 'app-1',
      }),
    ).resolves.toMatchObject({
      status: 'applied',
      targetPageTitle: 'Legacy new title',
    });

    expect(pageService.update).toHaveBeenCalledWith(
      page,
      expect.objectContaining({
        title: 'Legacy new title',
      }),
      expect.anything(),
    );
    expect(applicationRepo.updateApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          patch: expect.objectContaining({
            originalPageTitle: 'Old title',
            proposedPageTitle: 'Legacy new title',
          }),
        }),
      }),
    );
  });
});

function applicationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    reviewItemId: 'rev-1',
    status: 'draft',
    operation: 'replace_section',
    targetPageId: 'page-1',
    targetPageTitle: 'Old title',
    targetHeadingPath: [],
    basePageVersion: '2026-06-22T10:00:00.000Z',
    baseContentHash: hashContent('Before content'),
    beforeContent: 'Before content',
    afterContent: 'After content',
    afterContentHash: hashContent('After content'),
    patch: {},
    createdPageId: null,
    appliedAt: null,
    revertedAt: null,
    appliedBy: 'user-1',
    rationale: '',
    sourceRefs: [],
    createdAt: new Date('2026-06-22T10:00:00.000Z'),
    updatedAt: new Date('2026-06-22T10:00:00.000Z'),
    ...overrides,
  };
}

function pageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'page-1',
    slugId: 'page-slug',
    title: 'Old title',
    icon: null,
    coverPhoto: null,
    position: null,
    parentPageId: null,
    creatorId: 'user-1',
    lastUpdatedById: 'user-1',
    spaceId: 'space-1',
    workspaceId: 'workspace-1',
    isLocked: false,
    createdAt: new Date('2026-06-22T10:00:00.000Z'),
    updatedAt: new Date('2026-06-22T10:00:00.000Z'),
    deletedAt: null,
    contributorIds: [],
    content: null,
    space: { slug: 'space' },
    ...overrides,
  };
}

function hashContent(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
