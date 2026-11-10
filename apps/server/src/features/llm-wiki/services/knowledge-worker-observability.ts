type KnowledgeWorkerEvent = 'stalled' | 'lock_renewal_failed';

const MAX_RETAINED_EVENTS = 10_000;
const eventTimes: Record<KnowledgeWorkerEvent, number[]> = {
  stalled: [],
  lock_renewal_failed: [],
};

export function recordKnowledgeWorkerEvent(
  event: KnowledgeWorkerEvent,
  count = 1,
  occurredAt = Date.now(),
): void {
  const boundedCount = Math.min(Math.max(Math.trunc(count), 1), 1_000);
  const values = eventTimes[event];
  for (let index = 0; index < boundedCount; index += 1) {
    values.push(occurredAt);
  }
  if (values.length > MAX_RETAINED_EVENTS) {
    values.splice(0, values.length - MAX_RETAINED_EVENTS);
  }
}

export function getKnowledgeWorkerEventSnapshot(
  windowMs = 60 * 60 * 1_000,
  sampledAt = Date.now(),
) {
  const since = sampledAt - windowMs;
  for (const values of Object.values(eventTimes)) {
    while (values.length > 0 && values[0] < since) values.shift();
  }
  return {
    windowMs,
    stalled: eventTimes.stalled.length,
    lockRenewalFailed: eventTimes.lock_renewal_failed.length,
    source: 'process_local' as const,
  };
}
