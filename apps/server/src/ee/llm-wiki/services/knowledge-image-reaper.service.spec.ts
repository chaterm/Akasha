import { KnowledgeImageReaperService } from './knowledge-image-reaper.service';

describe('KnowledgeImageReaperService', () => {
  it('does not touch an unexpired activation or an executable exact job', async () => {
    const fixture = createFixture({ state: 'active' });
    await fixture.service.reap();
    expect(fixture.repo.requeueMissingRunImage).not.toHaveBeenCalled();
    expect(fixture.repo.completeRunImage).not.toHaveBeenCalled();
  });

  it('requeues a missing job with the same identity up to three times', async () => {
    const fixture = createFixture({ missing: true, recoveryCount: 1 });
    await fixture.service.reap();
    expect(fixture.repo.requeueMissingRunImage).toHaveBeenCalledWith(
      expect.objectContaining({
        runImageId: 'run-image-1',
        jobId: 'image-job-1',
      }),
    );
  });

  it.each([
    ['failed', 'image_job_attempts_exhausted'],
    ['completed', 'image_job_completed_without_db_terminal'],
  ])('terminally records an exact %s job', async (state, errorCode) => {
    const fixture = createFixture({ state });
    await fixture.service.reap();
    expect(fixture.repo.completeRunImage).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        failureClass: 'retryable_exhausted',
        errorCode,
      }),
    );
  });

  it('does not mutate DB state when Redis inspection fails', async () => {
    const fixture = createFixture({ redisError: true });
    await fixture.service.reap();
    expect(fixture.repo.requeueMissingRunImage).not.toHaveBeenCalled();
    expect(fixture.repo.completeRunImage).not.toHaveBeenCalled();
  });
});

function createFixture(input: {
  state?: string;
  missing?: boolean;
  redisError?: boolean;
  recoveryCount?: number;
}) {
  const repo = {
    findRunImageRecoveryCandidates: jest.fn().mockResolvedValue([
      {
        runImageId: 'run-image-1',
        runId: 'run-1',
        knowledgeGeneration: 2,
        jobId: 'image-job-1',
        redisRecoveryCount: input.recoveryCount ?? 0,
      },
    ]),
    requeueMissingRunImage: jest.fn().mockResolvedValue(true),
    completeRunImage: jest.fn().mockResolvedValue({ imageStatus: 'failed' }),
  };
  const queue = {
    getJob: jest.fn().mockImplementation(async () => {
      if (input.redisError) throw new Error('redis unavailable');
      if (input.missing) return undefined;
      return { getState: jest.fn().mockResolvedValue(input.state ?? 'active') };
    }),
  };
  return {
    repo,
    service: new KnowledgeImageReaperService(queue as never, repo as never),
  };
}
