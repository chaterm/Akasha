import { QueueJob } from '../../integrations/queue/constants';
import { PageListener } from './page.listener';

describe('PageListener knowledge jobs', () => {
  it('enqueues delayed knowledge compile jobs for page spaces on page creation', async () => {
    const { listener, aiQueue, pageRepo, compilationRepo } = createListener();
    pageRepo.findExistingPageRefs.mockResolvedValue([
      pageRef('page-1', 'space-1'),
    ]);

    await listener.handlePageCreated({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });

    expect(pageRepo.findExistingPageRefs).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });
    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_PAGES,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
      },
      {
        delay: 5000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        jobId: expect.stringMatching(
          /^knowledge-compile-pages__workspace-1__space-1__page-1__/,
        ),
      },
    );
    expect(compilationRepo.queueAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'page-1',
        sourceVersion: undefined,
        sourceContentHash: undefined,
        compileTaskId: expect.stringMatching(
          /^knowledge-compile-pages__workspace-1__space-1__page-1__/,
        ),
      }),
    );
    const compileAddCall = aiQueue.add.mock.calls.findIndex(
      ([name]) => name === QueueJob.KNOWLEDGE_COMPILE_PAGES,
    );
    expect(compileAddCall).toBeGreaterThanOrEqual(0);
    expect(
      compilationRepo.queueAttempt.mock.invocationCallOrder[0],
    ).toBeLessThan(aiQueue.add.mock.invocationCallOrder[compileAddCall]);
  });

  it('keeps last successful knowledge available while a page update recompiles', async () => {
    const { listener, aiQueue, pageRepo } = createListener();
    pageRepo.findExistingPageRefs.mockResolvedValue([
      pageRef('page-1', 'space-1'),
    ]);

    await listener.handlePageUpdated({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });

    expect(aiQueue.add).not.toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
      expect.anything(),
    );
    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      { workspaceId: 'workspace-1', sourcePageIds: ['page-1'] },
    );
    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_PAGES,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
      },
      {
        delay: 5000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        jobId: expect.stringMatching(
          /^knowledge-compile-pages__workspace-1__space-1__page-1__/,
        ),
      },
    );
  });

  it('enqueues knowledge stale jobs before deleted page events', async () => {
    const { listener, aiQueue, pageRepo } = createListener();

    await listener.handlePageDeleted({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });

    expect(aiQueue.add.mock.calls.slice(0, 2)).toEqual([
      [
        QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
        { workspaceId: 'workspace-1', sourcePageIds: ['page-1'] },
      ],
      [
        QueueJob.PAGE_DELETED,
        { pageIds: ['page-1'], workspaceId: 'workspace-1' },
      ],
    ]);
    expect(pageRepo.findExistingPageRefs).not.toHaveBeenCalled();
  });

  it('enqueues access reindex jobs when pages are created or restored', async () => {
    const { listener, aiQueue, pageRepo } = createListener();
    pageRepo.findExistingPageRefs
      .mockResolvedValueOnce([pageRef('page-1', 'space-1')])
      .mockResolvedValueOnce([pageRef('page-2', 'space-2')]);

    await listener.handlePageCreated({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });
    await listener.handlePageRestored({
      workspaceId: 'workspace-1',
      pageIds: ['page-2'],
    });

    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      { workspaceId: 'workspace-1', sourcePageIds: ['page-1'] },
    );
    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      { workspaceId: 'workspace-1', sourcePageIds: ['page-2'] },
    );
    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_PAGES,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-2',
        sourcePageIds: ['page-2'],
      },
      {
        delay: 5000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        jobId: expect.stringMatching(
          /^knowledge-compile-pages__workspace-1__space-2__page-2__/,
        ),
      },
    );
  });
});

function createListener() {
  const environmentService = {
    getSearchDriver: jest.fn().mockReturnValue('database'),
  };
  const searchQueue = {
    add: jest.fn().mockResolvedValue(undefined),
  };
  const aiQueue = {
    add: jest.fn().mockResolvedValue(undefined),
  };
  const pageRepo = {
    findSpaceIdsForPages: jest.fn().mockResolvedValue([]),
    findExistingPageRefs: jest.fn().mockResolvedValue([]),
  };
  const compilationRepo = {
    queueAttempt: jest.fn().mockResolvedValue(undefined),
  };

  return {
    listener: new PageListener(
      environmentService as never,
      pageRepo as never,
      searchQueue as never,
      aiQueue as never,
      compilationRepo as never,
    ),
    searchQueue,
    aiQueue,
    pageRepo,
    compilationRepo,
  };
}

function pageRef(id: string, spaceId: string) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId,
    deletedAt: null,
  };
}
