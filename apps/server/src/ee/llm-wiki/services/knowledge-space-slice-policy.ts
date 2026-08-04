export type SpaceSliceCheckpointDecision =
  | { yield: false }
  | { yield: true; reason: 'page_limit' | 'time_limit' };

export function decideSpaceSliceCheckpoint(input: {
  completedPages: number;
  elapsedMs: number;
  remainingPages: number;
  maxPages: number;
  maxMs: number;
}): SpaceSliceCheckpointDecision {
  if (input.remainingPages <= 0) return { yield: false };
  if (input.completedPages >= input.maxPages) {
    return { yield: true, reason: 'page_limit' };
  }
  if (input.elapsedMs >= input.maxMs) {
    return { yield: true, reason: 'time_limit' };
  }
  return { yield: false };
}

export function calculateSpaceSlotReleaseUpperBoundMs(input: {
  sliceMaxMs: number;
  pageDeadlineMs: number;
  aggregateDeadlineMs: number;
  outboxIntervalMs: number;
}): number {
  return (
    input.sliceMaxMs +
    input.pageDeadlineMs +
    input.aggregateDeadlineMs +
    input.outboxIntervalMs
  );
}
