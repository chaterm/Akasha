import { QueueJob } from '../../integrations/queue/constants';
import { PageListener } from './page.listener';

describe('PageListener knowledge jobs', () => {
  it('keeps access indexing and schedules page creation after the quiet period', async () => {
    const { listener, knowledgeQueue, runRepo } = createListener();

    await listener.handlePageCreated({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });

    expect(knowledgeQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      { workspaceId: 'workspace-1', sourcePageIds: ['page-1'] },
    );
    expect(runRepo.scheduleIncrementalCompileForPages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
      trigger: 'page_created',
      quietPeriodMs: 60 * 60 * 1_000,
    });
    expect(runRepo.requestIncrementalCompileForPages).not.toHaveBeenCalled();
    expect(knowledgeQueue.add).not.toHaveBeenCalledWith(
      'knowledge-compile-pages',
      expect.anything(),
      expect.anything(),
    );
  });

  it('keeps search and access indexing but skips run requests for ZIP imports', async () => {
    const { listener, knowledgeQueue, runRepo } = createListener();

    await listener.handlePageCreated({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
      skipKnowledgeCompile: true,
    });

    expect(knowledgeQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      { workspaceId: 'workspace-1', sourcePageIds: ['page-1'] },
    );
    expect(runRepo.requestIncrementalCompileForPages).not.toHaveBeenCalled();
    expect(runRepo.scheduleIncrementalCompileForPages).not.toHaveBeenCalled();
  });

  it('keeps last successful knowledge visible while postponing an update run', async () => {
    const { listener, knowledgeQueue, runRepo } = createListener();

    await listener.handlePageUpdated({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });

    expect(knowledgeQueue.add).not.toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
      expect.anything(),
    );
    expect(runRepo.scheduleIncrementalCompileForPages).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'page_updated',
        quietPeriodMs: 60 * 60 * 1_000,
      }),
    );
    expect(runRepo.requestIncrementalCompileForPages).not.toHaveBeenCalled();
    expect(knowledgeQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_RETIRE_SOURCES,
      { workspaceId: 'workspace-1', sourcePageIds: ['page-1'] },
      expect.objectContaining({ attempts: 5, delay: 1_000 }),
    );
  });

  it('leaves all knowledge maintenance to the post-commit content queue for content saves', async () => {
    const { listener, searchQueue, knowledgeQueue, runRepo } = createListener();

    await listener.handlePageUpdated({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
      skipKnowledgeCompile: true,
    });

    // Search indexing still runs. ACL reindex and scheduling are owned by the
    // post-commit PAGE_CONTENT_UPDATED job; retirement is unnecessary because a
    // collaboration content save does not change the page's Space.
    expect(searchQueue.add).toHaveBeenCalledWith(QueueJob.PAGE_UPDATED, {
      pageIds: ['page-1'],
    });
    expect(knowledgeQueue.add).not.toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      expect.anything(),
    );
    expect(knowledgeQueue.add).not.toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_RETIRE_SOURCES,
      expect.anything(),
      expect.anything(),
    );
    expect(runRepo.scheduleIncrementalCompileForPages).not.toHaveBeenCalled();
    expect(runRepo.requestIncrementalCompileForPages).not.toHaveBeenCalled();
  });

  it.each([
    ['hard delete', 'handlePageDeleted'],
    ['soft delete', 'handlePageSoftDeleted'],
  ] as const)(
    'uses precise source retirement for %s',
    async (_label, method) => {
      const { listener, knowledgeQueue, runRepo } = createListener();

      await listener[method]({
        workspaceId: 'workspace-1',
        pageIds: ['page-1'],
      });

      expect(knowledgeQueue.add).toHaveBeenCalledWith(
        QueueJob.KNOWLEDGE_RETIRE_SOURCES,
        {
          workspaceId: 'workspace-1',
          sourcePageIds: ['page-1'],
        },
        expect.objectContaining({ attempts: 5, delay: 1_000 }),
      );
      expect(runRepo.requestIncrementalCompileForPages).not.toHaveBeenCalled();
      expect(knowledgeQueue.add).not.toHaveBeenCalledWith(
        QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
        expect.anything(),
      );
    },
  );

  it('keeps restore invalidation/access maintenance and requests a new run', async () => {
    const { listener, knowledgeQueue, runRepo } = createListener();

    await listener.handlePageRestored({
      workspaceId: 'workspace-1',
      pageIds: ['page-2'],
    });

    expect(knowledgeQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
      {
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-2'],
        mode: 'source_artifacts',
      },
    );
    expect(knowledgeQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      { workspaceId: 'workspace-1', sourcePageIds: ['page-2'] },
    );
    expect(runRepo.requestIncrementalCompileForPages).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePageIds: ['page-2'], removed: false }),
    );
  });

  it('coalesces repeated page updates in the durable delayed schedule', async () => {
    const { listener, runRepo } = createListener();

    await listener.handlePageUpdated({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });
    await listener.handlePageUpdated({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });

    expect(runRepo.scheduleIncrementalCompileForPages).toHaveBeenCalledTimes(2);
    expect(runRepo.requestIncrementalCompileForPages).not.toHaveBeenCalled();
  });
});

describe('PageListener page restore with the night compile window', () => {
  it('requests the restore Run immediately when the window switch is off', async () => {
    const { listener, runRepo } = createListener({ windowEnabled: false });

    await listener.handlePageRestored({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });

    expect(runRepo.requestIncrementalCompileForPages).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1'],
        trigger: 'page_update',
        removed: false,
      }),
    );
    expect(runRepo.scheduleIncrementalCompileForPages).not.toHaveBeenCalled();
  });

  it('drops the one-hour quiet period for edits while the window switch is on', async () => {
    const { listener, runRepo } = createListener({ windowEnabled: true });

    await listener.handlePageCreated({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });
    await listener.handlePageUpdated({
      workspaceId: 'workspace-1',
      pageIds: ['page-2'],
    });

    expect(runRepo.scheduleIncrementalCompileForPages).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ trigger: 'page_created', quietPeriodMs: 0 }),
    );
    expect(runRepo.scheduleIncrementalCompileForPages).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ trigger: 'page_updated', quietPeriodMs: 0 }),
    );
  });

  it('queues the restore as a due schedule when the window switch is on', async () => {
    const { listener, runRepo, compileWindowRepo } = createListener({
      windowEnabled: true,
    });

    await listener.handlePageRestored({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });

    expect(compileWindowRepo.isEnabled).toHaveBeenCalledWith('workspace-1');
    expect(runRepo.scheduleIncrementalCompileForPages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
      trigger: 'page_restored',
      quietPeriodMs: 0,
    });
    expect(runRepo.requestIncrementalCompileForPages).not.toHaveBeenCalled();
  });
});

function createListener(options: { windowEnabled?: boolean } = {}) {
  const environmentService = {
    getSearchDriver: jest.fn().mockReturnValue('database'),
  };
  const searchQueue = {
    add: jest.fn().mockResolvedValue(undefined),
  };
  const knowledgeQueue = {
    add: jest.fn().mockResolvedValue(undefined),
  };
  const runRepo = {
    requestIncrementalCompileForPages: jest.fn().mockResolvedValue([]),
    scheduleIncrementalCompileForPages: jest.fn().mockResolvedValue(1),
  };
  const compileWindowRepo = {
    isEnabled: jest.fn().mockResolvedValue(options.windowEnabled ?? false),
  };

  return {
    listener: new PageListener(
      environmentService as never,
      searchQueue as never,
      knowledgeQueue as never,
      runRepo as never,
      compileWindowRepo as never,
    ),
    searchQueue,
    knowledgeQueue,
    runRepo,
    compileWindowRepo,
  };
}
