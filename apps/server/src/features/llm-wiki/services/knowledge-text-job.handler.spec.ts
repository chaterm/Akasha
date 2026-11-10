import { Job } from 'bullmq';
import { QueueJob } from '../../../integrations/queue/constants';
import { KnowledgeTextJobHandler } from './knowledge-text-job.handler';

describe('KnowledgeTextJobHandler maintenance boundary', () => {
  it('reindexes exact source access when source page ids are provided', async () => {
    const fixture = createFixture();

    await fixture.handler.handle(
      job(QueueJob.KNOWLEDGE_REINDEX_ACCESS, {
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1', 'page-2'],
      }),
    );

    expect(fixture.accessIndexer.reindexSourcePages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1', 'page-2'],
    });
  });

  it('reindexes one 200-page space batch and enqueues a deterministic continuation', async () => {
    const sourcePageIds = Array.from(
      { length: 200 },
      (_, index) => `page-${String(index).padStart(3, '0')}`,
    );
    const fixture = createFixture();
    fixture.sourceRepo.findSourcePageIdsBySpaceBatch.mockResolvedValue(
      sourcePageIds,
    );

    await fixture.handler.handle(
      job(QueueJob.KNOWLEDGE_REINDEX_ACCESS, {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    );

    expect(
      fixture.sourceRepo.findSourcePageIdsBySpaceBatch,
    ).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      limit: 200,
    });
    expect(fixture.textQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        afterSourcePageId: 'page-199',
      },
      {
        jobId: expect.stringMatching(
          /^knowledge-reindex-access__workspace-1__space-1__/,
        ),
      },
    );
  });

  it('marks sources and dependent capsules stale', async () => {
    const fixture = createFixture();

    await fixture.handler.handle(
      job(QueueJob.KNOWLEDGE_MARK_SOURCES_STALE, {
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1'],
      }),
    );

    expect(fixture.sourceRepo.markSourcesStale).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });
    expect(
      fixture.capsuleRepo.markCapsulesStaleBySourcePageIds,
    ).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });
  });

  it('can invalidate only page-owned source artifacts', async () => {
    const fixture = createFixture();

    await fixture.handler.handle(
      job(QueueJob.KNOWLEDGE_MARK_SOURCES_STALE, {
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1'],
        mode: 'source_artifacts',
      }),
    );

    expect(
      fixture.capsuleRepo.markSourceArtifactsStaleBySourcePageIds,
    ).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });
    expect(
      fixture.capsuleRepo.markCapsulesStaleBySourcePageIds,
    ).not.toHaveBeenCalled();
  });

  it('routes deleted and moved sources through precise retirement', async () => {
    const fixture = createFixture();

    await fixture.handler.handle(
      job(QueueJob.KNOWLEDGE_RETIRE_SOURCES, {
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1', 'page-1', 'page-2'],
      }),
    );

    expect(
      fixture.sourceRetirement.retireOutOfScopeSources,
    ).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1', 'page-2'],
    });
  });

  it('keeps content-updated pages available and schedules delayed compilation', async () => {
    const fixture = createFixture();

    await fixture.handler.handle(
      job(QueueJob.PAGE_CONTENT_UPDATED, {
        workspaceId: 'workspace-1',
        pageIds: ['page-1', 'page-2', 'page-1'],
      }),
    );

    expect(fixture.accessIndexer.reindexSourcePages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1', 'page-2', 'page-1'],
    });
    expect(
      fixture.spaceCompilation.scheduleIncrementalCompileForPages,
    ).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1', 'page-2'],
      trigger: 'page_updated',
    });
    expect(
      fixture.spaceCompilation.requestIncrementalCompileForPages,
    ).not.toHaveBeenCalled();
    expect(fixture.sourceRepo.markSourcesStale).not.toHaveBeenCalled();
  });

  it('checkpoints embedding rebuilds with a deterministic continuation job', async () => {
    const fixture = createFixture();
    fixture.vectorIndex.rebuildSpaceEmbeddings.mockResolvedValue({
      rebuiltChunkCount: 50,
      nextCursor: 'chunk-049',
    });

    await expect(
      fixture.handler.handle(
        job(QueueJob.KNOWLEDGE_REBUILD_EMBEDDINGS, {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          afterChunkId: 'chunk-before',
          embeddingConcurrency: 4,
        }),
      ),
    ).resolves.toMatchObject({ rebuiltChunkCount: 50 });

    expect(fixture.vectorIndex.rebuildSpaceEmbeddings).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      afterChunkId: 'chunk-before',
      embeddingConcurrency: 4,
    });
    expect(fixture.textQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_REBUILD_EMBEDDINGS,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        afterChunkId: 'chunk-049',
        embeddingConcurrency: 4,
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        jobId: expect.stringMatching(
          /^knowledge-rebuild-embeddings__workspace-1__space-1__/,
        ),
      },
    );
  });

  it('fails an embedding rebuild batch instead of skipping failed chunks', async () => {
    const fixture = createFixture();
    fixture.vectorIndex.rebuildSpaceEmbeddings.mockResolvedValue({
      rebuiltChunkCount: 49,
      failedChunkIds: ['chunk-010'],
      nextCursor: 'chunk-049',
    });

    await expect(
      fixture.handler.handle(
        job(QueueJob.KNOWLEDGE_REBUILD_EMBEDDINGS, {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
        }),
      ),
    ).rejects.toThrow('Knowledge embedding rebuild failed for 1 chunk(s).');
    expect(fixture.textQueue.add).not.toHaveBeenCalled();
  });

  it('ignores queue jobs outside the retained maintenance allowlist', async () => {
    const fixture = createFixture();

    await expect(
      fixture.handler.handle(job(QueueJob.PAGE_CREATED, {})),
    ).resolves.toBeUndefined();
    expect(fixture.accessIndexer.reindexSourcePages).not.toHaveBeenCalled();
    expect(
      fixture.spaceCompilation.requestIncrementalCompileForPages,
    ).not.toHaveBeenCalled();
  });
});

function createFixture() {
  const accessIndexer = { reindexSourcePages: jest.fn() };
  const sourceRepo = {
    findSourcePageIdsBySpaceBatch: jest.fn().mockResolvedValue([]),
    findSourcesBySpace: jest.fn().mockResolvedValue([]),
    markSourcesStale: jest.fn(),
  };
  const capsuleRepo = {
    markCapsulesStaleBySourcePageIds: jest.fn(),
    markSourceArtifactsStaleBySourcePageIds: jest.fn(),
    findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
      pages: [],
      links: [],
      pageSources: [],
    }),
  };
  const textQueue = { add: jest.fn() };
  const spaceCompilation = {
    requestIncrementalCompileForPages: jest.fn(),
    scheduleIncrementalCompileForPages: jest.fn(),
  };
  const vectorIndex = {
    rebuildSpaceEmbeddings: jest
      .fn()
      .mockResolvedValue({ rebuiltChunkCount: 0 }),
  };
  const sourceRetirement = {
    retireOutOfScopeSources: jest.fn(),
  };
  const handler = new KnowledgeTextJobHandler(
    accessIndexer as never,
    sourceRepo as never,
    capsuleRepo as never,
    textQueue as never,
    spaceCompilation as never,
    vectorIndex as never,
    sourceRetirement as never,
  );
  return {
    handler,
    accessIndexer,
    sourceRepo,
    capsuleRepo,
    textQueue,
    spaceCompilation,
    vectorIndex,
    sourceRetirement,
  };
}

function job(name: string, data: unknown): Job {
  return { name, data, opts: {}, attemptsMade: 0 } as Job;
}
