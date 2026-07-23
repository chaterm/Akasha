import { ForbiddenException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { User, Workspace } from '@akasha/db/types/entity.types';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { UserRole } from '../../../common/helpers/types/permission';
import { IAuditService } from '../../../integrations/audit/audit.service';
import { QueueJob } from '../../../integrations/queue/constants';
import { ReviewController } from './review.controller';
import { ReviewItem, ReviewJob } from './review.schema';
import { ReviewSnapshotService } from './review-snapshot.service';
import type { ReviewApplyService } from './review-apply.service';

jest.mock('./review-apply.service', () => ({
  ReviewApplyService: class ReviewApplyService {},
}));

describe('ReviewController', () => {
  it('rejects review discovery when workspace AI is disabled', async () => {
    const aiQueue = createAiQueue();
    const auditService = {
      log: jest.fn(),
    };
    const controller = createController({ aiQueue, auditService });

    await expect(
      controller.discover(
        { spaceId: 'space-1' },
        adminUser(),
        workspace({ ai: { chat: false } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(aiQueue.add).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('loads the saved snapshot for a space', async () => {
    const snapshotService = {
      loadSnapshot: jest.fn().mockResolvedValue({
        version: '2',
        items: [],
        docs: [],
        resolvedReviews: [],
        jobs: [],
        applications: [],
        discoveredAt: '2026-06-22T03:00:00.000Z',
        updatedAt: '2026-06-22T03:00:00.000Z',
      }),
    };
    const controller = createController({ snapshotService });

    await expect(
      controller.load({ spaceId: 'space-1' }, adminUser(), workspace()),
    ).resolves.toEqual({
      version: '2',
      items: [],
      docs: [],
      resolvedReviews: [],
      jobs: [],
      applications: [],
      discoveredAt: '2026-06-22T03:00:00.000Z',
      updatedAt: '2026-06-22T03:00:00.000Z',
    });

    expect(snapshotService.loadSnapshot).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
  });

  it('queues review discovery without storing or auditing review content', async () => {
    const job = reviewJobFixture({
      jobId: 'review-discover__workspace-1__space-1',
      kind: 'discover',
    });
    const aiQueue = createAiQueue();
    const auditService = {
      log: jest.fn(),
    };
    const controller = createController({
      aiQueue,
      auditService,
      snapshotService: {
        beginJob: jest.fn().mockResolvedValue({ job, isNew: true }),
      },
    });

    await expect(
      controller.discover(
        { spaceId: 'space-1', limit: 20 },
        adminUser(),
        workspace(),
      ),
    ).resolves.toEqual({
      job,
      result: null,
    });

    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.REVIEW_DISCOVER,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        limit: 20,
      },
      { jobId: 'review-discover__workspace-1__space-1' },
    );
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('audits skipped negotiation without generating a draft', async () => {
    const item: ReviewItem = {
      id: 'rev-2',
      type: 'missing-page',
      title: 'Add rollout page',
      detail: 'Rollout is referenced but missing.',
      recommendation: 'Create a rollout page.',
      relatedDocIds: ['kp-1'],
      searchQueries: ['rollout plan'],
      outline: ['Goal', 'Steps'],
    };
    const aiQueue = createAiQueue();
    const auditService = {
      log: jest.fn(),
    };
    const controller = createController({
      aiQueue,
      auditService,
      snapshotService: {
        saveResolvedReview: jest.fn().mockResolvedValue(undefined),
      },
    });

    await expect(
      controller.negotiate(
        { spaceId: 'space-1', item, feedback: '暂时跳过' },
        adminUser(),
        workspace(),
      ),
    ).resolves.toEqual({
      item,
      feedback: '暂时跳过',
      skipped: true,
      deepSearched: false,
      searchResults: [],
      draft: null,
      applied: null,
      turns: [],
    });

    expect(aiQueue.add).not.toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith({
      event: AuditEvent.KNOWLEDGE_REVIEW_NEGOTIATED,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: 'space-1',
      spaceId: 'space-1',
      metadata: {
        reviewItemId: 'rev-2',
        reviewItemType: 'missing-page',
        feedbackKind: 'skip',
        skipped: true,
        deepSearched: false,
        searchResultCount: 0,
        negotiationTurnCount: 0,
        draftApplyOperation: null,
        hasDraft: false,
        targetDocId: null,
        applied: false,
        appliedAction: null,
        appliedPageId: null,
      },
    });
  });

  it('keeps negotiation read-only and plans application separately', async () => {
    const item: ReviewItem = {
      id: 'rev-3',
      type: 'suggestion',
      title: 'Add rollback section',
      detail: 'The launch page lacks rollback criteria.',
      recommendation: 'Add a rollback section.',
      relatedDocIds: ['kp-1'],
      searchQueries: ['rollback criteria'],
      targetDocId: 'kp-1',
    };
    const draft = {
      title: 'Rollback criteria',
      body: '## Rollback criteria\n\nRollback when error budget burns fast.',
      applyOperation: ['append-section'] as const,
      targetDocId: 'kp-1',
      notes: 'Adds an operational checklist.',
    };
    const application = applicationFixture({
      reviewItemId: item.id,
      operation: 'insert_under_heading',
      targetPageId: 'page-1',
    });
    const job = reviewJobFixture({
      jobId: 'review-negotiate__workspace-1__space-1__rev-3',
      kind: 'negotiate',
      itemId: item.id,
    });
    const aiQueue = createAiQueue();
    const applyService = {
      planDraft: jest.fn().mockResolvedValue(application),
      applyApplication: jest.fn(),
    };
    const snapshotService = {
      loadSnapshot: jest.fn().mockResolvedValue({
        version: '2',
        items: [item],
        docs: [{ id: 'kp-1', title: 'Launch plan', sourcePageId: 'page-1' }],
        resolvedReviews: [
          {
            item,
            feedback: '采纳',
            skipped: false,
            deepSearched: false,
            searchResults: [],
            draft,
            applied: null,
            turns: [
              {
                feedback: '采纳',
                draft,
                deepSearched: false,
                searchResults: [],
              },
            ],
          },
        ],
        jobs: [],
        applications: [],
        discoveredAt: '2026-06-22T03:00:00.000Z',
        updatedAt: '2026-06-22T03:00:00.000Z',
      }),
      beginJob: jest.fn().mockResolvedValue({ job, isNew: true }),
    };
    const controller = createController({
      aiQueue,
      applyService,
      snapshotService,
    });

    await expect(
      controller.negotiate(
        { spaceId: 'space-1', item, feedback: '采纳' },
        adminUser(),
        workspace(),
      ),
    ).resolves.toMatchObject({
      job,
      result: null,
    });
    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.REVIEW_NEGOTIATE,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        item,
        feedback: '采纳',
      },
      { jobId: 'review-negotiate__workspace-1__space-1__rev-3' },
    );
    expect(applyService.planDraft).not.toHaveBeenCalled();
    expect(applyService.applyApplication).not.toHaveBeenCalled();

    await expect(
      controller.plan(
        item.id,
        { spaceId: 'space-1' },
        adminUser(),
        workspace(),
      ),
    ).resolves.toEqual(application);

    expect(applyService.planDraft).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      user: expect.objectContaining({ id: 'user-1' }),
      item,
      draft,
      docs: [{ id: 'kp-1', title: 'Launch plan', sourcePageId: 'page-1' }],
      searchResults: [],
    });
  });

  it('queues follow-up negotiation without trusting client-supplied history', async () => {
    const item: ReviewItem = {
      id: 'rev-4',
      type: 'suggestion',
      title: 'Improve rollback section',
      detail: 'The rollback section needs refinement.',
      recommendation: 'Refine rollback wording.',
      relatedDocIds: ['kp-1'],
      searchQueries: ['rollback criteria'],
      targetDocId: 'kp-1',
    };
    const firstDraft = {
      title: 'Rollback criteria',
      body: '## Rollback criteria\n\nRollback when error budget burns fast.',
      applyOperation: ['append-section'] as const,
      targetDocId: 'kp-1',
      notes: '',
    };
    const priorTurn = {
      feedback: '采纳',
      draft: firstDraft,
      deepSearched: false,
      searchResults: [],
    };
    const job = reviewJobFixture({
      jobId: 'review-negotiate__workspace-1__space-1__rev-4',
      kind: 'negotiate',
      itemId: item.id,
    });
    const aiQueue = createAiQueue();
    const controller = createController({
      aiQueue,
      snapshotService: {
        loadSnapshot: jest.fn().mockResolvedValue({
          version: '2',
          items: [item],
          docs: [],
          resolvedReviews: [
            {
              item,
              feedback: '采纳',
              skipped: false,
              deepSearched: false,
              searchResults: [],
              draft: firstDraft,
              applied: null,
              turns: [priorTurn],
            },
          ],
          jobs: [],
          applications: [],
          discoveredAt: '2026-06-22T03:00:00.000Z',
          updatedAt: '2026-06-22T03:10:00.000Z',
        }),
        beginJob: jest.fn().mockResolvedValue({ job, isNew: true }),
      },
    });

    await expect(
      controller.negotiate(
        {
          spaceId: 'space-1',
          item,
          feedback: '把触发条件改得更准确',
          priorTurns: [priorTurn],
        },
        adminUser(),
        workspace(),
      ),
    ).resolves.toMatchObject({
      job,
      result: null,
    });

    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.REVIEW_NEGOTIATE,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        item,
        feedback: '把触发条件改得更准确',
      },
      { jobId: 'review-negotiate__workspace-1__space-1__rev-4' },
    );
    expect(JSON.stringify(aiQueue.add.mock.calls)).not.toContain('priorTurns');
  });

  it('allows a re-reviewed item even when a previous application with the same item id was applied', async () => {
    const item: ReviewItem = {
      id: 'rev-1',
      type: 'suggestion',
      title: 'Refresh SLO guidance',
      detail: 'The current review found new missing SLO detail.',
      recommendation: 'Update the SLO page.',
      relatedDocIds: ['kp-1'],
      searchQueries: ['slo guidance'],
      targetDocId: 'kp-1',
    };
    const job = reviewJobFixture({
      jobId: 'review-negotiate__workspace-1__space-1__rev-1',
      kind: 'negotiate',
      itemId: item.id,
    });
    const aiQueue = createAiQueue();
    const controller = createController({
      aiQueue,
      snapshotService: {
        loadSnapshot: jest.fn().mockResolvedValue({
          version: '2',
          items: [item],
          docs: [{ id: 'kp-1', title: 'SLO', sourcePageId: 'page-1' }],
          resolvedReviews: [],
          jobs: [],
          applications: [
            applicationFixture({
              reviewItemId: item.id,
              status: 'applied',
              appliedAt: '2026-06-22T03:10:00.000Z',
            }),
          ],
          discoveredAt: '2026-06-25T03:00:00.000Z',
          updatedAt: '2026-06-25T03:00:00.000Z',
        }),
        beginJob: jest.fn().mockResolvedValue({ job, isNew: true }),
      },
    });

    await expect(
      controller.negotiate(
        { spaceId: 'space-1', item, feedback: '采纳' },
        adminUser(),
        workspace(),
      ),
    ).resolves.toMatchObject({
      job,
      result: null,
    });

    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.REVIEW_NEGOTIATE,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        item,
        feedback: '采纳',
      },
      { jobId: 'review-negotiate__workspace-1__space-1__rev-1' },
    );
  });
});

function createController(
  overrides: {
    applyService?: Partial<ReviewApplyService>;
    snapshotService?: Partial<ReviewSnapshotService>;
    aiQueue?: Queue & { add: jest.Mock };
    auditService?: Partial<IAuditService>;
  } = {},
): ReviewController {
  const auditService = {
    log: jest.fn(),
    ...overrides.auditService,
  } as unknown as IAuditService;
  const defaultDiscoverJob = reviewJobFixture({
    jobId: 'review-discover__workspace-1__space-1',
    kind: 'discover',
  });
  const snapshotService = {
    loadSnapshot: jest.fn().mockResolvedValue(null),
    replaceDiscoveredSnapshot: jest.fn().mockResolvedValue({
      version: '2',
      items: [],
      docs: [],
      resolvedReviews: [],
      jobs: [],
      applications: [],
      discoveredAt: '2026-06-22T03:00:00.000Z',
      updatedAt: '2026-06-22T03:00:00.000Z',
    }),
    saveResolvedReview: jest.fn().mockResolvedValue(undefined),
    beginJob: jest
      .fn()
      .mockResolvedValue({ job: defaultDiscoverJob, isNew: true }),
    markJobFailed: jest.fn().mockResolvedValue(undefined),
    getJob: jest.fn().mockResolvedValue(null),
    ...overrides.snapshotService,
  } as unknown as ReviewSnapshotService;
  const applyService = {
    planDraft: jest.fn().mockResolvedValue(applicationFixture()),
    applyApplication: jest.fn().mockResolvedValue(applicationFixture()),
    revertApplication: jest.fn().mockResolvedValue(applicationFixture()),
    getDiff: jest.fn().mockResolvedValue({
      application: applicationFixture(),
      beforeContent: 'before',
      afterContent: 'after',
    }),
    ...overrides.applyService,
  } as unknown as ReviewApplyService;
  const aiQueue = overrides.aiQueue ?? createAiQueue();

  return new ReviewController(
    applyService,
    snapshotService,
    aiQueue,
    auditService,
  );
}

function workspace(settings: Record<string, unknown> = { ai: { chat: true } }) {
  return {
    id: 'workspace-1',
    settings,
  } as Workspace;
}

function adminUser(): User {
  return {
    id: 'user-1',
    role: UserRole.ADMIN,
  } as User;
}

function createAiQueue(): Queue & { add: jest.Mock } {
  return {
    add: jest.fn().mockResolvedValue(undefined),
  } as unknown as Queue & { add: jest.Mock };
}

function reviewJobFixture(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    jobId: 'review-job-1',
    kind: 'discover',
    itemId: null,
    status: 'pending',
    error: null,
    createdAt: '2026-06-25T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function applicationFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    reviewItemId: 'rev-1',
    status: 'draft',
    operation: 'create_page',
    targetPageId: null,
    targetPageTitle: 'Draft page',
    targetHeadingPath: [],
    basePageVersion: null,
    baseContentHash: null,
    beforeContent: null,
    afterContent: '# Draft page',
    afterContentHash: 'sha256:after',
    patch: null,
    createdPageId: null,
    appliedAt: null,
    revertedAt: null,
    appliedBy: 'user-1',
    rationale: 'rationale',
    sourceRefs: [],
    createdAt: '2026-06-22T03:00:00.000Z',
    updatedAt: '2026-06-22T03:00:00.000Z',
    ...overrides,
  };
}
