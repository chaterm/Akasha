import { KnowledgeRunReaperService } from './knowledge-run-reaper.service';

describe('KnowledgeRunReaperService', () => {
  it.each(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'])(
    'does not recover a stale queued reservation while the exact Redis job is still %s',
    async (state) => {
      const fixture = createFixture({ state });
      fixture.repo.findSpaceRecoveryCandidates.mockResolvedValue([
        candidate({ status: 'queued', executionLeaseExpiresAt: null }),
      ]);
      await fixture.service.reap();
      expect(fixture.repo.claimRecoveryLease).not.toHaveBeenCalled();
    },
  );

  it.each(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'])(
    'requeues an expired leased job even when the exact Redis job is still %s',
    async (state) => {
      const fixture = createFixture({ state });
      await fixture.service.reap();
      expect(fixture.repo.claimRecoveryLease).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          spaceJobId: 'job-1',
          recoveryKind: 'expired',
        }),
      );
      expect(fixture.repo.requeueMissingSpaceSlice).toHaveBeenCalledWith(
        fixture.lease,
      );
      expect(fixture.repo.finishRun).not.toHaveBeenCalled();
    },
  );

  it('finishes an exact final failed job through a recovery lease', async () => {
    const fixture = createFixture({ state: 'failed' });
    await fixture.service.reap();
    expect(fixture.repo.claimRecoveryLease).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        spaceJobId: 'job-1',
        recoveryKind: 'expired',
      }),
    );
    expect(fixture.repo.finishRun).toHaveBeenCalledWith(
      fixture.lease,
      'failed',
      expect.objectContaining({ errorCode: 'job_attempts_exhausted' }),
    );
  });

  it('allows recovery without an execution lease only for a stale queued reservation', async () => {
    const fixture = createFixture({ state: 'missing' });
    fixture.repo.findSpaceRecoveryCandidates.mockResolvedValue([
      candidate({ status: 'queued', executionLeaseExpiresAt: null }),
    ]);

    await fixture.service.reap();

    expect(fixture.repo.claimRecoveryLease).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryKind: 'queued_reservation' }),
    );
  });

  it('requeues a missing exact job at most three times', async () => {
    const fixture = createFixture({ missing: true, recoveryCount: 2 });
    await fixture.service.reap();
    expect(fixture.repo.requeueMissingSpaceSlice).toHaveBeenCalledWith(
      fixture.lease,
    );
    expect(fixture.repo.finishRun).not.toHaveBeenCalled();

    fixture.repo.findSpaceRecoveryCandidates.mockResolvedValue([
      candidate({ spaceJobRecoveryCount: 3 }),
    ]);
    await fixture.service.reap();
    expect(fixture.repo.finishRun).toHaveBeenCalledWith(
      fixture.lease,
      'failed',
      expect.objectContaining({ errorCode: 'redis_job_missing_exhausted' }),
    );
  });

  it('fails an expired leased executable job after bounded recovery is exhausted', async () => {
    const fixture = createFixture({ state: 'active', recoveryCount: 3 });
    await fixture.service.reap();
    expect(fixture.repo.requeueMissingSpaceSlice).not.toHaveBeenCalled();
    expect(fixture.repo.finishRun).toHaveBeenCalledWith(
      fixture.lease,
      'failed',
      expect.objectContaining({ errorCode: 'redis_job_stale_exhausted' }),
    );
  });

  it('does nothing when Redis state cannot be read', async () => {
    const fixture = createFixture({ redisError: true });
    await fixture.service.reap();
    expect(fixture.repo.claimRecoveryLease).not.toHaveBeenCalled();
  });
});

function createFixture(input: {
  state?: string;
  missing?: boolean;
  recoveryCount?: number;
  redisError?: boolean;
}) {
  const lease = {
    runId: 'run-1',
    knowledgeGeneration: 2,
    jobPhase: 'text' as const,
    spaceJobSequence: 1,
    spaceJobId: 'job-1',
    executionToken: 'recovery-token',
  };
  const repo = {
    findSpaceRecoveryCandidates: jest
      .fn()
      .mockResolvedValue([
        candidate({ spaceJobRecoveryCount: input.recoveryCount ?? 0 }),
      ]),
    claimRecoveryLease: jest.fn().mockResolvedValue(lease),
    requeueMissingSpaceSlice: jest.fn().mockResolvedValue(true),
    finishRun: jest.fn().mockResolvedValue({ run: { status: 'failed' } }),
  };
  const queue = {
    getJob: jest.fn().mockImplementation(async () => {
      if (input.redisError) throw new Error('redis unavailable');
      if (input.missing) return undefined;
      return { getState: jest.fn().mockResolvedValue(input.state ?? 'active') };
    }),
  };
  return {
    lease,
    repo,
    service: new KnowledgeRunReaperService(queue as never, repo as never),
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    knowledgeGeneration: 2,
    jobPhase: 'text',
    spaceJobSequence: 1,
    spaceJobId: 'job-1',
    executionLeaseExpiresAt: new Date(Date.now() - 60_000),
    status: 'compiling',
    spaceJobRecoveryCount: 0,
    ...overrides,
  };
}
