import { KnowledgePageMergeReaperService } from './knowledge-page-merge-reaper.service';

describe('KnowledgePageMergeReaperService', () => {
  it('passes the observed attempt and expiry into missing transport recovery', async () => {
    const { service, repo } = fixture('missing');
    await service.reap();
    expect(repo.requeueMissingPageMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        mergeExecutionToken: 'observed-token',
        mergeRedisRecoveryCount: 2,
        mergeProcessingExpiresAt: expect.any(Date),
        mergeDispatchedAt: null,
        observedAt: expect.any(Date),
        queuedDispatchedBefore: expect.any(Date),
      }),
    );
    expect(repo.terminalizePageMerge).not.toHaveBeenCalled();
  });

  it.each(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'])(
    'preserves executable %s jobs and their Run slot',
    async (state) => {
      const { service, repo } = fixture(state);
      await service.reap();
      expect(repo.requeueMissingPageMerge).not.toHaveBeenCalled();
      expect(repo.terminalizePageMerge).not.toHaveBeenCalled();
    },
  );

  it('terminalizes exhausted recovery using the same observed attempt fence', async () => {
    const { service, repo } = fixture('missing', 3);
    await service.reap();
    expect(repo.terminalizePageMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        mergeExecutionToken: 'observed-token',
        mergeRedisRecoveryCount: 3,
        errorCode: 'merge_redis_job_missing_exhausted',
      }),
    );
    expect(repo.requeueMissingPageMerge).not.toHaveBeenCalled();
  });

  it('leaves database state unchanged when Redis inspection fails', async () => {
    const { service, repo, queue } = fixture('missing');
    queue.getJob.mockRejectedValue(new Error('Redis unavailable'));
    await service.reap();
    expect(repo.requeueMissingPageMerge).not.toHaveBeenCalled();
    expect(repo.terminalizePageMerge).not.toHaveBeenCalled();
  });
});

function fixture(state: string, count = 2) {
  const queue = {
    getJob: jest
      .fn()
      .mockResolvedValue(
        state === 'missing' ? undefined : { getState: async () => state },
      ),
  };
  const repo = {
    findPageMergeRecoveryCandidates: jest.fn().mockResolvedValue([
      {
        runPageId: 'page-1',
        runId: 'run-1',
        knowledgeGeneration: 0,
        mergeJobId: 'merge-1',
        mergeStatus: 'running',
        mergeExecutionToken: 'observed-token',
        mergeProcessingExpiresAt: new Date(Date.now() - 1_000),
        mergeDispatchedAt: null,
        mergeRedisRecoveryCount: count,
      },
    ]),
    requeueMissingPageMerge: jest.fn().mockResolvedValue(true),
    terminalizePageMerge: jest.fn().mockResolvedValue(true),
  };
  return {
    service: new KnowledgePageMergeReaperService(queue as never, repo as never),
    repo,
    queue,
  };
}
