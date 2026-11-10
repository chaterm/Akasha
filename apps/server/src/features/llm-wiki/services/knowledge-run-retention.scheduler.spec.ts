import { KnowledgeRunRetentionScheduler } from './knowledge-run-retention.scheduler';

describe('KnowledgeRunRetentionScheduler', () => {
  it('stops when a batch finds no more eligible history', async () => {
    const fixture = createFixture();
    fixture.retention.purgeExpiredRunHistoryBatch
      .mockResolvedValueOnce(batch({ deletedImages: 10 }))
      .mockResolvedValueOnce(batch());

    await fixture.scheduler.purgeExpiredRunHistory();

    expect(fixture.retention.purgeExpiredRunHistoryBatch).toHaveBeenCalledTimes(
      2,
    );
  });

  it('runs at most twenty batches in one daily schedule', async () => {
    const fixture = createFixture();
    fixture.retention.purgeExpiredRunHistoryBatch.mockResolvedValue(
      batch({ deletedImages: 1 }),
    );

    await fixture.scheduler.purgeExpiredRunHistory();

    expect(fixture.retention.purgeExpiredRunHistoryBatch).toHaveBeenCalledTimes(
      20,
    );
  });

  it('can run again after a failed batch', async () => {
    const fixture = createFixture();
    fixture.retention.purgeExpiredRunHistoryBatch
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(batch());

    await fixture.scheduler.purgeExpiredRunHistory();
    await fixture.scheduler.purgeExpiredRunHistory();

    expect(fixture.retention.purgeExpiredRunHistoryBatch).toHaveBeenCalledTimes(
      2,
    );
  });

  it('purges stale artifacts until a batch deletes nothing', async () => {
    const fixture = createFixture();
    fixture.retention.purgeStaleArtifactsBatch
      .mockResolvedValueOnce(staleBatch({ deletedKnowledgePages: 200 }))
      .mockResolvedValueOnce(staleBatch({ deletedKnowledgePages: 3 }))
      .mockResolvedValueOnce(staleBatch());

    await fixture.scheduler.purgeExpiredRunHistory();

    expect(fixture.retention.purgeStaleArtifactsBatch).toHaveBeenCalledTimes(3);
  });

  it('runs at most twenty stale artifact batches in one daily schedule', async () => {
    const fixture = createFixture();
    fixture.retention.purgeStaleArtifactsBatch.mockResolvedValue(
      staleBatch({ deletedKnowledgePages: 200 }),
    );

    await fixture.scheduler.purgeExpiredRunHistory();

    expect(fixture.retention.purgeStaleArtifactsBatch).toHaveBeenCalledTimes(
      20,
    );
  });

  it('still purges stale artifacts when run history retention fails', async () => {
    const fixture = createFixture();
    fixture.retention.purgeExpiredRunHistoryBatch.mockRejectedValueOnce(
      new Error('run history unavailable'),
    );

    await expect(
      fixture.scheduler.purgeExpiredRunHistory(),
    ).resolves.toBeUndefined();

    expect(fixture.retention.purgeStaleArtifactsBatch).toHaveBeenCalledTimes(1);
  });

  it('skips a failed stale artifact batch and continues the backlog', async () => {
    const fixture = createFixture();
    fixture.retention.purgeStaleArtifactsBatch
      .mockResolvedValueOnce(staleBatch({ deletedKnowledgePages: 200 }))
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce(staleBatch({ deletedKnowledgePages: 200 }))
      .mockResolvedValueOnce(staleBatch());

    await fixture.scheduler.purgeExpiredRunHistory();

    expect(fixture.retention.purgeStaleArtifactsBatch).toHaveBeenCalledTimes(4);
  });

  it('gives up for the day after three consecutive batch failures', async () => {
    const fixture = createFixture();
    fixture.retention.purgeStaleArtifactsBatch.mockRejectedValue(
      new Error('database unavailable'),
    );

    await fixture.scheduler.purgeExpiredRunHistory();

    expect(fixture.retention.purgeStaleArtifactsBatch).toHaveBeenCalledTimes(3);
  });

  it('resets the failure streak after a successful batch', async () => {
    const fixture = createFixture();
    fixture.retention.purgeStaleArtifactsBatch
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce(staleBatch({ deletedKnowledgePages: 1 }))
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce(staleBatch());

    await fixture.scheduler.purgeExpiredRunHistory();

    expect(fixture.retention.purgeStaleArtifactsBatch).toHaveBeenCalledTimes(6);
  });

  it('backs off and retries while the remaining rows are locked by another purger', async () => {
    const fixture = createFixture();
    fixture.retention.purgeStaleArtifactsBatch
      .mockResolvedValueOnce(staleBatch({ remainingLocked: true }))
      .mockResolvedValueOnce(staleBatch({ deletedKnowledgePages: 200 }))
      .mockResolvedValueOnce(staleBatch());

    await fixture.scheduler.purgeExpiredRunHistory();

    expect(fixture.retention.purgeStaleArtifactsBatch).toHaveBeenCalledTimes(3);
    expect(fixture.delay).toHaveBeenCalledTimes(1);
  });

  it('bounds lock backoff retries by the batch cap', async () => {
    const fixture = createFixture();
    fixture.retention.purgeStaleArtifactsBatch.mockResolvedValue(
      staleBatch({ remainingLocked: true }),
    );

    await fixture.scheduler.purgeExpiredRunHistory();

    expect(fixture.retention.purgeStaleArtifactsBatch).toHaveBeenCalledTimes(
      20,
    );
  });
});

function createFixture() {
  const retention = {
    purgeExpiredRunHistoryBatch: jest.fn().mockResolvedValue(batch()),
    purgeStaleArtifactsBatch: jest.fn().mockResolvedValue(staleBatch()),
  };
  const scheduler = new KnowledgeRunRetentionScheduler(retention as never);
  const delay = jest
    .spyOn(scheduler as unknown as { delay: () => Promise<void> }, 'delay')
    .mockResolvedValue(undefined);
  return { retention, scheduler, delay };
}

function batch(
  overrides: Partial<{
    deletedImages: number;
    deletedPages: number;
    deletedRuns: number;
    durationMs: number;
  }> = {},
) {
  return {
    deletedImages: 0,
    deletedPages: 0,
    deletedRuns: 0,
    durationMs: 1,
    ...overrides,
  };
}

function staleBatch(
  overrides: Partial<{
    deletedKnowledgePages: number;
    danglingLinks: number;
    remainingLocked: boolean;
    durationMs: number;
  }> = {},
) {
  return {
    deletedKnowledgePages: 0,
    danglingLinks: 0,
    remainingLocked: false,
    durationMs: 1,
    ...overrides,
  };
}
