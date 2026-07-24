import { Queue } from 'bullmq';
import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import { KnowledgeSpaceCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-compilation.repo';
import { QueueJob } from '../../../integrations/queue/constants';
import { KnowledgeArtifactCatalogService } from './knowledge-artifact-catalog.service';
import { KnowledgeSpaceCompilationService } from './knowledge-space-compilation.service';

describe('KnowledgeSpaceCompilationService', () => {
  it('persists a catalog/source snapshot and dispatches idempotent page jobs', async () => {
    const { service, repo, queue, compilationRepo, catalog } = createService();

    await expect(
      service.startSpaceRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'manual_compile',
        sources: [source()],
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'run-1' }));

    expect(catalog.snapshot).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(repo.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        catalogSnapshot: [expect.objectContaining({ canonicalKey: 'alpha' })],
        catalogHash: 'sha256:catalog',
        sources: [
          expect.objectContaining({
            sourcePageId: 'page-1',
            sourceVersion: 'v1',
            sourceContentHash: 'hash-1',
          }),
        ],
      }),
    );
    const jobId =
      'knowledge-compile-pages__workspace-1__space-1__page-1__run-1';
    expect(compilationRepo.queueAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ compileTaskId: jobId, compilerRunId: 'run-1' }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_PAGES,
      expect.objectContaining({
        sourcePageIds: ['page-1'],
        spaceRunId: 'run-1',
        sourceVersion: 'v1',
        sourceContentHash: 'hash-1',
      }),
      expect.objectContaining({ jobId, attempts: 3 }),
    );
    expect(repo.markPageQueued).toHaveBeenCalledWith({
      runId: 'run-1',
      sourcePageId: 'page-1',
      jobId,
    });
  });

  it('dispatches aggregate-pending runs with a stable job id', async () => {
    const { service, repo, queue } = createService({
      pendingPages: [],
      pendingAggregates: [
        {
          id: 'run-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
        },
      ],
    });

    await service.dispatchPending();

    expect(queue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_AGGREGATE_SPACE,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        spaceRunId: 'run-1',
      },
      expect.objectContaining({
        jobId: 'knowledge-aggregate-space__run-1',
        attempts: 3,
      }),
    );
    expect(repo.markAggregationQueued).toHaveBeenCalledWith({
      runId: 'run-1',
      jobId: 'knowledge-aggregate-space__run-1',
    });
  });
});

function createService(
  overrides: { pendingPages?: unknown[]; pendingAggregates?: unknown[] } = {},
) {
  const pendingPages = overrides.pendingPages ?? [
    {
      runId: 'run-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      expectedSourceVersion: 'v1',
      expectedSourceContentHash: 'hash-1',
      trigger: 'manual_compile',
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    },
  ];
  const repo = {
    createRun: jest.fn().mockResolvedValue({ id: 'run-1', status: 'queued' }),
    findPendingPageDispatches: jest.fn().mockResolvedValue(pendingPages),
    markPageQueued: jest.fn().mockResolvedValue(undefined),
    findAggregatePendingRuns: jest
      .fn()
      .mockResolvedValue(overrides.pendingAggregates ?? []),
    markAggregationQueued: jest.fn().mockResolvedValue(undefined),
  };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const compilationRepo = {
    queueAttempt: jest.fn().mockResolvedValue(undefined),
  };
  const catalog = {
    snapshot: jest.fn().mockResolvedValue({
      entries: [
        {
          artifactId: 'artifact-1',
          artifactKind: 'concept',
          canonicalKey: 'alpha',
          title: 'Alpha',
          summary: 'Alpha body',
        },
      ],
      hash: 'sha256:catalog',
    }),
  };
  const service = new KnowledgeSpaceCompilationService(
    queue as unknown as Queue,
    repo as unknown as KnowledgeSpaceCompilationRepo,
    compilationRepo as unknown as KnowledgeCompilationRepo,
    catalog as unknown as KnowledgeArtifactCatalogService,
  );
  return { service, repo, queue, compilationRepo, catalog };
}

function source() {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'page-1',
    sourceVersion: 'v1',
    contentHash: 'hash-1',
    title: 'Page',
    text: 'Body',
    references: [],
  };
}
