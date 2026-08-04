import { QueueJob } from '../../integrations/queue/constants';
import {
  DEFAULT_KNOWLEDGE_COMPILER_VERSION,
  DEFAULT_KNOWLEDGE_PROMPT_VERSION,
} from '../../ee/llm-wiki/llm-wiki.constants';
import { PageListener } from './page.listener';

describe('PageListener knowledge jobs', () => {
  it('keeps access indexing and requests one space run for page creation', async () => {
    const { listener, knowledgeQueue, runRepo } = createListener();

    await listener.handlePageCreated({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });

    expect(knowledgeQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      { workspaceId: 'workspace-1', sourcePageIds: ['page-1'] },
    );
    expect(runRepo.requestIncrementalCompileForPages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
      trigger: 'page_update',
      removed: false,
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
    });
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
  });

  it('keeps last successful knowledge visible while requesting an update run', async () => {
    const { listener, knowledgeQueue, runRepo } = createListener();

    await listener.handlePageUpdated({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });

    expect(knowledgeQueue.add).not.toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
      expect.anything(),
    );
    expect(runRepo.requestIncrementalCompileForPages).toHaveBeenCalledWith(
      expect.objectContaining({ removed: false }),
    );
  });

  it.each([
    ['hard delete', 'handlePageDeleted'],
    ['soft delete', 'handlePageSoftDeleted'],
  ] as const)(
    'uses the transactional fail-closed run request for %s',
    async (_label, method) => {
      const { listener, knowledgeQueue, runRepo } = createListener();

      await listener[method]({
        workspaceId: 'workspace-1',
        pageIds: ['page-1'],
      });

      expect(runRepo.requestIncrementalCompileForPages).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'workspace-1',
          sourcePageIds: ['page-1'],
          removed: true,
        }),
      );
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

  it('always delegates active-run arbitration to the locked repository', async () => {
    const { listener, runRepo } = createListener();
    runRepo.requestIncrementalCompileForPages.mockResolvedValue([
      { disposition: 'rerun_requested', run: { id: 'run-1' } },
    ]);

    await listener.handlePageUpdated({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });

    expect(runRepo.requestIncrementalCompileForPages).toHaveBeenCalledTimes(1);
  });
});

function createListener() {
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
  };

  return {
    listener: new PageListener(
      environmentService as never,
      searchQueue as never,
      knowledgeQueue as never,
      runRepo as never,
    ),
    searchQueue,
    knowledgeQueue,
    runRepo,
  };
}
