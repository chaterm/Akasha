/**
 * Night compile window: when enabled, deferrable (non-manual) knowledge
 * compilation only starts inside [startTime, endTime) of the server's local
 * time (the process TZ; the Docker image sets TZ=Asia/Shanghai). Pure
 * functions so the gate is testable without a clock or DB.
 */
export interface KnowledgeCompileWindowConfig {
  enabled: boolean;
  /** HH:mm, inclusive. */
  startTime: string;
  /** HH:mm, exclusive. A value earlier than startTime crosses midnight. */
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

/** IANA name of the server's local timezone, shown to admins as a hint. */
export function serverTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Reads the stored settings value defensively. Anything malformed is treated
 * as disabled so a bad row can never block compilation.
 */
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

/** Minutes since local midnight (with seconds) in the given timezone. */
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

/**
 * True when deferrable compilation may start now. Disabled = always open.
 * `timezone` defaults to the server's local timezone; tests pin it.
 */
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

/**
 * When a delayed page compile will actually start: the later of its
 * quiet-period deadline (or now, if already due) and the next window start.
 * `windowDeferred` is true when the window, not the quiet period, decides.
 */
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

/**
 * Next instant the window opens, or null when it is open (or disabled).
 * Computed as a minute offset from now in local time; a DST shift between
 * now and the start can move the result by up to the shift size, which is
 * acceptable for a user-facing hint.
 */
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
  // Round away float noise from the seconds fraction onto the minute.
  return new Date(
    Math.round((now.getTime() + delta * 60_000) / 60_000) * 60_000,
  );
}
