export interface KnowledgeCompileWindowConfig {
  enabled: boolean;
  startTime: string;
  endTime: string;
}

export const KNOWLEDGE_COMPILE_WINDOW_DISABLED: KnowledgeCompileWindowConfig = {
  enabled: false,
  startTime: '23:00',
  endTime: '07:00',
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidCompileWindowTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_PATTERN.test(value);
}

export function serverTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function parseCompileWindowConfig(
  value: unknown,
): KnowledgeCompileWindowConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return KNOWLEDGE_COMPILE_WINDOW_DISABLED;
  }
  const record = value as Record<string, unknown>;
  if (
    !isValidCompileWindowTime(record.startTime) ||
    !isValidCompileWindowTime(record.endTime)
  ) {
    return KNOWLEDGE_COMPILE_WINDOW_DISABLED;
  }
  return {
    enabled: record.enabled === true && record.startTime !== record.endTime,
    startTime: record.startTime,
    endTime: record.endTime,
  };
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function localMinutesOfDay(now: Date, timezone?: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const read = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return read('hour') * 60 + read('minute') + read('second') / 60;
}

export function isCompileWindowOpen(
  config: KnowledgeCompileWindowConfig,
  now: Date,
  timezone?: string,
): boolean {
  if (!config.enabled) return true;
  const start = toMinutes(config.startTime);
  const end = toMinutes(config.endTime);
  const current = localMinutesOfDay(now, timezone);
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

export function effectiveCompileStartAt(
  config: KnowledgeCompileWindowConfig,
  eligibleAt: Date,
  now: Date,
  timezone?: string,
): { startAt: Date; windowDeferred: boolean } {
  const base = eligibleAt.getTime() > now.getTime() ? eligibleAt : now;
  const windowStart = nextCompileWindowStartAt(config, base, timezone);
  return windowStart
    ? { startAt: windowStart, windowDeferred: true }
    : { startAt: base, windowDeferred: false };
}

export function nextCompileWindowStartAt(
  config: KnowledgeCompileWindowConfig,
  now: Date,
  timezone?: string,
): Date | null {
  if (isCompileWindowOpen(config, now, timezone)) return null;
  const start = toMinutes(config.startTime);
  const current = localMinutesOfDay(now, timezone);
  let delta = start - current;
  if (delta <= 0) delta += 24 * 60;
  return new Date(
    Math.round((now.getTime() + delta * 60_000) / 60_000) * 60_000,
  );
}
