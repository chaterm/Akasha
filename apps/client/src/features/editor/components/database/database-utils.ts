import {
  getDatabaseCellText,
  hasDatabaseOptions,
  readDatabaseValue,
  type DatabaseColor,
  type DatabaseColumn,
  type DatabaseRowData,
  type DatabaseSelectOption,
} from "@docmost/editor-ext";

/** Mantine palette name for each database color. */
export const DATABASE_COLOR_MAP: Record<DatabaseColor, string> = {
  gray: "gray",
  red: "red",
  pink: "pink",
  orange: "orange",
  yellow: "yellow",
  green: "green",
  teal: "teal",
  cyan: "cyan",
  blue: "blue",
  purple: "violet",
};

export function toDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function parseDateKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/** 0 = Sunday … 6 = Saturday, from the locale's week data when the runtime has it. */
export function getWeekStart(locale: string): number {
  try {
    const info = (Intl.Locale.prototype as any).getWeekInfo
      ? (new Intl.Locale(locale) as any).getWeekInfo()
      : (new Intl.Locale(locale) as any).weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch {
    // Fall through to the heuristic.
  }
  return /^(en-US|en-CA|ja|ko|zh-TW|pt-BR|he)/i.test(locale) ? 0 : 1;
}

/** Whole weeks covering the month (4 to 6), each 7 date keys long. */
export function buildMonthWeeks(
  year: number,
  month: number,
  weekStartsOn: number,
): string[][] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() - weekStartsOn + 7) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const weeks = Math.ceil((offset + days) / 7);
  return Array.from({ length: weeks }, (_, week) =>
    Array.from({ length: 7 }, (_, day) =>
      toDateKey(new Date(year, month, 1 - offset + week * 7 + day)),
    ),
  );
}

export interface CalendarSegment<T> {
  item: T;
  /** Column of the first day in this week (0-6) and number of days covered. */
  column: number;
  span: number;
  slot: number;
  continuesLeft: boolean;
  continuesRight: boolean;
}

/**
 * Cuts date ranges into one segment per week they touch and stacks the
 * segments of each week into non-overlapping slots (longest first).
 */
export function layoutCalendarWeek<T>(
  week: string[],
  items: { item: T; start: string; end: string }[],
): CalendarSegment<T>[] {
  const first = week[0];
  const last = week[6];
  const segments = items
    .filter(({ start, end }) => start <= last && end >= first)
    .map(({ item, start, end }) => {
      const from = start < first ? 0 : week.indexOf(start);
      const to = end > last ? 6 : week.indexOf(end);
      return {
        item,
        column: from,
        span: to - from + 1,
        slot: 0,
        continuesLeft: start < first,
        continuesRight: end > last,
      };
    })
    .sort((a, b) => a.column - b.column || b.span - a.span);

  const slotEnds: number[] = [];
  for (const segment of segments) {
    let slot = slotEnds.findIndex((end) => end < segment.column);
    if (slot < 0) slot = slotEnds.length;
    slotEnds[slot] = segment.column + segment.span - 1;
    segment.slot = slot;
  }
  return segments;
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, item);
  return next;
}

/** Options a row has in `column`, in the row's order. */
function rowOptions(
  column: DatabaseColumn,
  row: DatabaseRowData,
): DatabaseSelectOption[] {
  const value = readDatabaseValue(column, row);
  const ids = Array.isArray(value) ? value : value ? [value as string] : [];
  return ids
    .map((id) => column.options?.find((option) => option.id === id))
    .filter(Boolean) as DatabaseSelectOption[];
}

/**
 * A row reduced for compact layouts (calendar entries, timeline items): the first
 * field's text as title, the first select value as a colored tag, members as
 * people, and the remaining plain fields joined as dimmed text.
 */
export function summarizeRow(
  fields: DatabaseColumn[],
  row: DatabaseRowData,
  locale: string,
) {
  const text = (column: DatabaseColumn) =>
    getDatabaseCellText(column, row.values[column.id] ?? null, locale);
  const [heading, ...rest] = fields;
  const tag =
    rest
      .filter((c) => c.type === "select" || c.type === "multiSelect")
      .flatMap((c) => rowOptions(c, row))[0] ?? null;
  return {
    title: heading ? text(heading) : "",
    tag,
    color: tag ? DATABASE_COLOR_MAP[tag.color] : "gray",
    people: rest
      .filter((c) => c.type === "person")
      .flatMap((c) => rowOptions(c, row)),
    // Documents read as their titles.
    extra: rest
      .filter((c) => c.type === "page" || !hasDatabaseOptions(c.type))
      .map(text)
      .filter(Boolean)
      .join(" · "),
  };
}
