import {
  effectiveCompileStartAt,
  isCompileWindowOpen,
  KnowledgeCompileWindowConfig,
  nextCompileWindowStartAt,
  parseCompileWindowConfig,
  serverTimezone,
} from './knowledge-compile-window.types';

const night: KnowledgeCompileWindowConfig = {
  enabled: true,
  startTime: '23:00',
  endTime: '07:00',
};

// The gate follows the server's local time; tests pin the zone explicitly.
// Asia/Shanghai is UTC+8 with no DST.
const TZ = 'Asia/Shanghai';
const shanghai = (hhmm: string, day = '2026-10-28') =>
  new Date(`${day}T${hhmm}:00+08:00`);

describe('knowledge compile window', () => {
  it('is always open when disabled', () => {
    expect(
      isCompileWindowOpen({ ...night, enabled: false }, shanghai('12:00'), TZ),
    ).toBe(true);
    expect(
      nextCompileWindowStartAt(
        { ...night, enabled: false },
        shanghai('12:00'),
        TZ,
      ),
    ).toBeNull();
  });

  it('handles a window that crosses midnight with inclusive start and exclusive end', () => {
    expect(isCompileWindowOpen(night, shanghai('22:59'), TZ)).toBe(false);
    expect(isCompileWindowOpen(night, shanghai('23:00'), TZ)).toBe(true);
    expect(isCompileWindowOpen(night, shanghai('03:00'), TZ)).toBe(true);
    expect(isCompileWindowOpen(night, shanghai('06:59'), TZ)).toBe(true);
    expect(isCompileWindowOpen(night, shanghai('07:00'), TZ)).toBe(false);
    expect(isCompileWindowOpen(night, shanghai('12:00'), TZ)).toBe(false);
  });

  it('handles a same-day window', () => {
    const config = { ...night, startTime: '01:00', endTime: '05:30' };
    expect(isCompileWindowOpen(config, shanghai('00:59'), TZ)).toBe(false);
    expect(isCompileWindowOpen(config, shanghai('01:00'), TZ)).toBe(true);
    expect(isCompileWindowOpen(config, shanghai('05:29'), TZ)).toBe(true);
    expect(isCompileWindowOpen(config, shanghai('05:30'), TZ)).toBe(false);
  });

  it('defaults to the server local timezone', () => {
    const now = new Date('2026-10-28T15:30:00Z');
    expect(isCompileWindowOpen(night, now)).toBe(
      isCompileWindowOpen(night, now, serverTimezone()),
    );
    expect(nextCompileWindowStartAt(night, now)).toEqual(
      nextCompileWindowStartAt(night, now, serverTimezone()),
    );
    // 15:30 UTC is 23:30 in Shanghai but still daytime in UTC.
    expect(isCompileWindowOpen(night, now, TZ)).toBe(true);
    expect(isCompileWindowOpen(night, now, 'UTC')).toBe(false);
  });

  it('returns the next window start on the same or the following day', () => {
    expect(nextCompileWindowStartAt(night, shanghai('12:00'), TZ)).toEqual(
      shanghai('23:00'),
    );
    const sameDay = { ...night, startTime: '01:00', endTime: '05:00' };
    expect(nextCompileWindowStartAt(sameDay, shanghai('06:15'), TZ)).toEqual(
      shanghai('01:00', '2026-10-29'),
    );
    expect(nextCompileWindowStartAt(night, shanghai('23:30'), TZ)).toBeNull();
  });

  it('follows DST transitions of the local timezone', () => {
    // Europe/Berlin leaves DST on 2026-10-25: 02:00 local = 00:00 UTC before,
    // 01:00 UTC after.
    const berlin = { ...night, startTime: '02:00', endTime: '04:00' };
    const tz = 'Europe/Berlin';
    expect(
      isCompileWindowOpen(berlin, new Date('2026-10-24T00:30:00Z'), tz),
    ).toBe(true);
    expect(
      isCompileWindowOpen(berlin, new Date('2026-10-26T00:30:00Z'), tz),
    ).toBe(false);
    expect(
      isCompileWindowOpen(berlin, new Date('2026-10-26T01:30:00Z'), tz),
    ).toBe(true);
  });

  it('starts a delayed page at the later of its quiet period and the window', () => {
    // Edited in the morning: quiet period ends 11:00, window opens 23:00.
    expect(
      effectiveCompileStartAt(night, shanghai('11:00'), shanghai('10:00'), TZ),
    ).toEqual({ startAt: shanghai('23:00'), windowDeferred: true });
    // Already due at noon, still waits for the window.
    expect(
      effectiveCompileStartAt(night, shanghai('11:00'), shanghai('12:00'), TZ),
    ).toEqual({ startAt: shanghai('23:00'), windowDeferred: true });
    // Quiet period ends inside the window: the quiet period decides.
    expect(
      effectiveCompileStartAt(night, shanghai('23:40'), shanghai('22:40'), TZ),
    ).toEqual({ startAt: shanghai('23:40'), windowDeferred: false });
    // Window off: unchanged behaviour.
    expect(
      effectiveCompileStartAt(
        { ...night, enabled: false },
        shanghai('11:00'),
        shanghai('10:00'),
        TZ,
      ),
    ).toEqual({ startAt: shanghai('11:00'), windowDeferred: false });
  });

  it('treats malformed stored settings as disabled', () => {
    expect(parseCompileWindowConfig(null).enabled).toBe(false);
    expect(parseCompileWindowConfig('x').enabled).toBe(false);
    expect(
      parseCompileWindowConfig({ ...night, startTime: '25:00' }).enabled,
    ).toBe(false);
    expect(
      parseCompileWindowConfig({ ...night, endTime: '23:00' }).enabled,
    ).toBe(false);
    expect(
      parseCompileWindowConfig({ ...night, enabled: 'true' }).enabled,
    ).toBe(false);
    expect(parseCompileWindowConfig(night)).toEqual(night);
  });

  it('ignores a timezone left over in older stored settings', () => {
    expect(
      parseCompileWindowConfig({ ...night, timezone: 'Europe/Berlin' }),
    ).toEqual(night);
  });
});
