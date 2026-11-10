import {
  calculateSpaceSlotReleaseUpperBoundMs,
  decideLeaseCheckpoint,
} from './knowledge-space-lease-policy';

describe('knowledge space slice policy', () => {
  it('yields after the fifth terminal page only when work remains', () => {
    expect(
      decideLeaseCheckpoint({
        completedPages: 5,
        elapsedMs: 100,
        remainingPages: 1,
        maxPages: 5,
        maxMs: 300_000,
      }),
    ).toEqual({ yield: true, reason: 'page_limit' });
    expect(
      decideLeaseCheckpoint({
        completedPages: 5,
        elapsedMs: 100,
        remainingPages: 0,
        maxPages: 5,
        maxMs: 300_000,
      }),
    ).toEqual({ yield: false });
  });

  it('uses elapsed monotonic time at the page checkpoint', () => {
    expect(
      decideLeaseCheckpoint({
        completedPages: 1,
        elapsedMs: 300_000,
        remainingPages: 2,
        maxPages: 5,
        maxMs: 300_000,
      }),
    ).toEqual({ yield: true, reason: 'time_limit' });
  });

  it('documents the default worst-case slot release bound', () => {
    expect(
      calculateSpaceSlotReleaseUpperBoundMs({
        leaseMaxMs: 300_000,
        pageDeadlineMs: 900_000,
        aggregateDeadlineMs: 300_000,
        outboxIntervalMs: 5_000,
      }),
    ).toBe(1_505_000);
  });
});
