import { BadRequestException } from '@nestjs/common';
import { resolveWeeklyReportPeriod as resolve } from './weekly-report-period';
import type { PrepareWeeklyReportInput } from './weekly-report.types';

describe('weekly report calendar periods', () => {
  const now = new Date('2026-01-01T00:30:00Z');
  it('defaults to Shanghai and computes Monday by Shanghai local time without user selection', () => {
    expect(resolve({}, new Date('2026-11-01T16:30:00Z'))).toEqual({
      timezone: 'Asia/Shanghai',
      periodStart: '2026-11-02',
      periodEnd: '2026-11-08',
      asOfDate: '2026-11-02',
    });
    expect(resolve({}, now).asOfDate).toBe('2026-01-01');
  });
  it('rejects an explicitly invalid timezone instead of changing the requested dates', () => {
    for (const timezone of ['', 'Mars/Olympus']) {
      expect(() => resolve({ timezone }, now)).toThrow(BadRequestException);
      try {
        resolve({ timezone }, now);
      } catch (error) {
        expect((error as BadRequestException).getResponse()).toMatchObject({
          code: 'INVALID_ARGUMENT',
        });
      }
    }
  });
  it('honors an explicitly requested timezone and respects local dates', () => {
    expect(resolve({ timezone: 'America/Los_Angeles' }, now)).toEqual({
      timezone: 'America/Los_Angeles',
      periodStart: '2025-12-29',
      periodEnd: '2026-01-04',
      asOfDate: '2025-12-31',
    });
  });
  it('computes the previous Monday through Sunday across a year boundary', () => {
    expect(
      resolve({ period: 'last_week', timezone: 'UTC' }, now),
    ).toMatchObject({
      periodStart: '2025-12-22',
      periodEnd: '2025-12-28',
    });
  });
  it.each([
    ['2026-03-08T06:59:59Z', '2026-03-02', '2026-03-08', '2026-03-08'],
    ['2026-03-08T07:00:00Z', '2026-03-02', '2026-03-08', '2026-03-08'],
    ['2026-03-09T04:00:00Z', '2026-03-09', '2026-03-15', '2026-03-09'],
    ['2026-11-01T05:30:00Z', '2026-10-26', '2026-11-01', '2026-11-01'],
    ['2026-11-01T06:30:00Z', '2026-10-26', '2026-11-01', '2026-11-01'],
    ['2026-11-02T05:00:00Z', '2026-11-02', '2026-11-08', '2026-11-02'],
  ])(
    'keeps calendar dates stable through DST at %s',
    (instant, periodStart, periodEnd, asOfDate) => {
      expect(
        resolve({ timezone: 'America/New_York' }, new Date(instant)),
      ).toMatchObject({
        periodStart,
        periodEnd,
        asOfDate,
      });
    },
  );
  it('permits inclusive custom ranges of any length, including leap day and a single day', () => {
    for (const [periodStart, periodEnd] of [
      ['2024-02-29', '2024-02-29'],
      ['2024-02-28', '2024-03-15'],
    ]) {
      expect(
        resolve(
          { period: 'custom', periodStart, periodEnd, timezone: 'UTC' },
          now,
        ),
      ).toMatchObject({ periodStart, periodEnd });
    }
  });
  it.each<PrepareWeeklyReportInput>([
    { period: 'custom', periodStart: '2025-02-29', periodEnd: '2025-03-01' },
    { period: 'custom', periodStart: '2026-04-31', periodEnd: '2026-05-01' },
    { period: 'custom', periodStart: '2026-3-01', periodEnd: '2026-03-02' },
    { period: 'custom', periodStart: '2026-01-02', periodEnd: '2026-01-01' },
    { period: 'custom', periodStart: '2026-01-01' },
    { period: 'this_week', periodStart: '2026-01-01', periodEnd: '2026-01-02' },
    { period: 'future_week' as 'this_week' },
  ])('rejects malformed or inconsistent date rules: %j', (input) => {
    expect(() => resolve({ ...input, timezone: 'UTC' }, now)).toThrow(
      BadRequestException,
    );
  });
});
