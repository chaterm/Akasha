import { BadRequestException } from '@nestjs/common';
import type { PrepareWeeklyReportInput } from './weekly-report.types';

export const DEFAULT_WEEKLY_REPORT_TIMEZONE = 'Asia/Shanghai';

function invalid(message: string): never {
  throw new BadRequestException({ code: 'INVALID_ARGUMENT', message });
}

function validDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  );
}

const shiftDate = (value: string, days: number) => {
  const day = new Date(`${value}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
};

export function resolveWeeklyReportPeriod(
  input: PrepareWeeklyReportInput,
  now = new Date(),
) {
  const timezone = input.timezone ?? DEFAULT_WEEKLY_REPORT_TIMEZONE;
  let today: string;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const part = (type: string) => parts.find((p) => p.type === type)!.value;
    today = `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    invalid('Invalid IANA timezone');
  }
  const period = input.period ?? 'this_week';
  if (period === 'custom') {
    if (
      !validDate(input.periodStart) ||
      !validDate(input.periodEnd) ||
      input.periodStart > input.periodEnd
    ) {
      invalid('Use a valid ordered periodStart and periodEnd (YYYY-MM-DD)');
    }
    return {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      timezone,
      asOfDate: today,
    };
  }
  if (
    !['this_week', 'last_week'].includes(period) ||
    input.periodStart ||
    input.periodEnd
  ) {
    invalid('Explicit dates require period=custom');
  }
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const start = shiftDate(
    today,
    -((weekday + 6) % 7) - (period === 'last_week' ? 7 : 0),
  );
  return {
    periodStart: start,
    periodEnd: shiftDate(start, 6),
    timezone,
    asOfDate: today,
  };
}
