import {
  getDatabaseCellText,
  hasDatabaseOptions,
  readDatabaseValue,
  type DatabaseColor,
  type DatabaseColumn,
  type DatabaseRowData,
  type DatabaseSelectOption,
  type DatabaseTimelineScale,
} from "@docmost/editor-ext";

/**
 * Use instead of `autoFocus` in popovers: they mount before being positioned,
 * so a plain focus scrolls the page.
 */
export function focusWithoutScroll(element: HTMLElement | null) {
  element?.focus({ preventScroll: true });
}

/** Scrolls `item` into view within `list` only, not the page. */
export function scrollIntoList(
  list: HTMLElement | null,
  item: HTMLElement | null,
) {
  if (!list || !item) return;
  const top =
    item.getBoundingClientRect().top -
    list.getBoundingClientRect().top +
    list.scrollTop;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (top + item.offsetHeight > list.scrollTop + list.clientHeight) {
    list.scrollTop = top + item.offsetHeight - list.clientHeight;
  }
}

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

// ---------------------------------------------------------------- timeline

/** Pixels per day at each zoom level. */
export const TIMELINE_DAY_WIDTH: Record<DatabaseTimelineScale, number> = {
  day: 40,
  week: 20,
  month: 5,
};

const TIMELINE_PADDING: Record<DatabaseTimelineScale, number> = {
  day: 7,
  week: 14,
  month: 45,
};

/** The axis never gets shorter than this, so a nearly empty view still fills the width. */
const TIMELINE_MIN_DAYS: Record<DatabaseTimelineScale, number> = {
  day: 42,
  week: 140,
  month: 365,
};

function shiftDays(key: string, days: number): string {
  const date = parseDateKey(key);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (parseDateKey(to).getTime() - parseDateKey(from).getTime()) / 86_400_000,
  );
}

/**
 * Days shown on the time axis: every row date plus today, padded on both
 * sides and aligned to whole weeks (week scale) or months (month scale).
 */
export function getTimelineWindow(
  dates: string[],
  today: string,
  scale: DatabaseTimelineScale,
  weekStart: number,
): { start: string; days: number } {
  const all = [...dates, today].sort();
  let start = shiftDays(all[0], -TIMELINE_PADDING[scale]);
  let end = shiftDays(all[all.length - 1], TIMELINE_PADDING[scale]);
  if (scale === "week") {
    start = shiftDays(
      start,
      -((parseDateKey(start).getDay() - weekStart + 7) % 7),
    );
  } else if (scale === "month") {
    start = `${start.slice(0, 7)}-01`;
  }
  const minEnd = shiftDays(start, TIMELINE_MIN_DAYS[scale] - 1);
  if (end < minEnd) end = minEnd;
  if (scale === "week") {
    end = shiftDays(end, (weekStart + 6 - parseDateKey(end).getDay() + 7) % 7);
  } else if (scale === "month") {
    const date = parseDateKey(end);
    end = toDateKey(new Date(date.getFullYear(), date.getMonth() + 1, 0));
  }
  return { start, days: daysBetween(start, end) + 1 };
}

export interface TimelineSpan {
  /** First date of the span. */
  date: string;
  /** Day offset from the window start. */
  offset: number;
  days: number;
}

/** Splits the window into consecutive days, weeks (starting on `weekStart`), months or years. */
export function splitTimeline(
  start: string,
  days: number,
  unit: "day" | "week" | "month" | "year",
  weekStart: number,
): TimelineSpan[] {
  const spans: TimelineSpan[] = [];
  for (let offset = 0; offset < days; offset++) {
    const key = shiftDays(start, offset);
    const date = parseDateKey(key);
    const boundary =
      unit === "day" ||
      (unit === "week" && date.getDay() === weekStart) ||
      (unit === "month" && date.getDate() === 1) ||
      (unit === "year" && date.getMonth() === 0 && date.getDate() === 1);
    if (boundary || !spans.length) spans.push({ date: key, offset, days: 0 });
    spans[spans.length - 1].days++;
  }
  return spans;
}

export interface RowMove {
  rowId: string;
  beforeRowId: string | null;
}

export function planRowMoves(
  allIds: string[],
  visibleIds: string[],
  selected: Set<string>,
  direction: "up" | "down",
): RowMove[] {
  const all = [...allIds];
  const visible = [...visibleIds];
  const moves: RowMove[] = [];
  const place = (rowId: string, beforeRowId: string | null) => {
    all.splice(all.indexOf(rowId), 1);
    const at = beforeRowId === null ? all.length : all.indexOf(beforeRowId);
    all.splice(at, 0, rowId);
    moves.push({ rowId, beforeRowId });
  };
  if (direction === "up") {
    for (let i = 1; i < visible.length; i++) {
      const id = visible[i];
      const neighbour = visible[i - 1];
      if (!selected.has(id) || selected.has(neighbour)) continue;
      visible[i - 1] = id;
      visible[i] = neighbour;
      place(id, neighbour);
    }
  } else {
    for (let i = visible.length - 2; i >= 0; i--) {
      const id = visible[i];
      const neighbour = visible[i + 1];
      if (!selected.has(id) || selected.has(neighbour)) continue;
      visible[i + 1] = id;
      visible[i] = neighbour;
      place(id, all[all.indexOf(neighbour) + 1] ?? null);
    }
  }
  return moves;
}
