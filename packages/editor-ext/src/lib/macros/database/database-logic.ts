import { generateNodeId } from '../../utils';
import {
  DATABASE_CHECKED_GROUP,
  DATABASE_EMPTY_GROUP,
  DATABASE_UNCHECKED_GROUP,
  isDatabaseDate,
  hasDatabaseOptions,
  isDatabaseMultiValue,
  isDatabaseReference,
  isDatabaseValueEmpty,
  nextDatabaseOptionColor,
  normalizeDatabaseCellValue,
  type DatabaseCellValue,
  type DatabaseColumn,
  type DatabaseColumnType,
  type DatabaseFilterCondition,
  type DatabaseFilterGroup,
  type DatabaseRowData,
  type DatabaseSelectOption,
  type DatabaseSort,
  type DatabaseView,
} from './database-schema';

/**
 * Pure view logic shared by the client views, the server (search/export) and
 * tests: formatting, sorting, filtering, grouping and type conversion.
 */

// ---------------------------------------------------------------- formatting

const CURRENCY_FORMATS = new Set(['CNY', 'USD', 'EUR', 'GBP', 'JPY']);

export function formatDatabaseNumber(
  value: number,
  column: Pick<DatabaseColumn, 'format' | 'decimals'>,
  locale?: string,
): string {
  const format = column.format ?? 'number';
  const options: Intl.NumberFormatOptions = {
    useGrouping: format !== 'number',
  };
  let number = value;
  if (format === 'percent') {
    // The stored value is what the user typed: 12 means 12 %.
    options.style = 'percent';
    number = value / 100;
  } else if (CURRENCY_FORMATS.has(format)) {
    options.style = 'currency';
    options.currency = format;
  }
  if (typeof column.decimals === 'number') {
    options.minimumFractionDigits = column.decimals;
    options.maximumFractionDigits = column.decimals;
  } else if (options.style !== 'currency') {
    options.maximumFractionDigits = 10;
  }
  try {
    return new Intl.NumberFormat(locale, options).format(number);
  } catch {
    return String(value);
  }
}

/** Parses user input such as "1,234.5", "¥ 12", "45%". Returns null for anything else. */
export function parseDatabaseNumber(
  input: string,
  locale?: string,
): number | null {
  const decimal = (1.1).toLocaleString(locale).charAt(1) || '.';
  const group = decimal === ',' ? '.' : ',';
  let text = input.trim().replace(/\s/g, '');
  if (!text) return null;
  text = text.split(group).join('');
  if (decimal !== '.') text = text.replace(decimal, '.');
  text = text.replace(/^[^\d+\-.]+|[^\d.]+$/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/** A safe href for a url cell, or null when the text is not a link we open. */
export function getDatabaseUrlHref(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  if (/^(https?:|mailto:)/i.test(text)) {
    try {
      return new URL(text).href;
    } catch {
      return null;
    }
  }
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(text)) return `https://${text}`;
  return null;
}

function optionName(column: DatabaseColumn, id: string): string {
  return column.options?.find((option) => option.id === id)?.name ?? '';
}

/** Human-readable cell text, used for HTML export, search text and copy. */
export function getDatabaseCellText(
  column: DatabaseColumn,
  value: DatabaseCellValue,
  locale?: string,
): string {
  const normalized = normalizeDatabaseCellValue(column.type, value);
  switch (column.type) {
    case 'select':
      return normalized ? optionName(column, normalized as string) : '';
    case 'multiSelect':
    case 'person':
    case 'page':
      return (normalized as string[])
        .map((id) => optionName(column, id))
        .filter(Boolean)
        .join(', ');
    case 'checkbox':
      return normalized ? '✓' : '';
    case 'number':
      return normalized === null
        ? ''
        : formatDatabaseNumber(normalized as number, column, locale);
    default:
      return (normalized as string | null) ?? '';
  }
}

// ---------------------------------------------------------------- dates

function dateToUTC(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

export function addDatabaseDays(value: string, days: number): string {
  return new Date(dateToUTC(value) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function diffDatabaseDays(from: string, to: string): number {
  return Math.round((dateToUTC(to) - dateToUTC(from)) / 86_400_000);
}

/** Start/end of a row in a calendar view; end is never before start. */
export function getDatabaseDateRange(
  row: DatabaseRowData,
  view: Pick<DatabaseView, 'dateColumnId' | 'endDateColumnId'>,
): { start: string; end: string } | null {
  const start = view.dateColumnId ? row.values[view.dateColumnId] : null;
  if (!isDatabaseDate(start)) return null;
  const end = view.endDateColumnId ? row.values[view.endDateColumnId] : null;
  return { start, end: isDatabaseDate(end) && end > start ? end : start };
}

/**
 * The normalized value with references to deleted options removed, so sort,
 * filter and grouping all treat them as empty, like the display does.
 */
export function readDatabaseValue(
  column: DatabaseColumn,
  row: DatabaseRowData,
): DatabaseCellValue {
  const value = normalizeDatabaseCellValue(
    column.type,
    row.values[column.id] ?? null,
  );
  if (!hasDatabaseOptions(column.type)) return value;
  const known = new Set(column.options?.map((option) => option.id));
  if (column.type === 'select')
    return known.has(value as string) ? value : null;
  return (value as string[]).filter((id) => known.has(id));
}

// ---------------------------------------------------------------- sorting

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function optionIndex(column: DatabaseColumn, id: string): number {
  const index = column.options?.findIndex((option) => option.id === id) ?? -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

/** Compares two non-empty values ascending. */
function compareValues(
  column: DatabaseColumn,
  left: DatabaseCellValue,
  right: DatabaseCellValue,
): number {
  switch (column.type) {
    case 'number':
      return (left as number) - (right as number);
    case 'checkbox':
      return Number(left === true) - Number(right === true);
    case 'select':
      return (
        optionIndex(column, left as string) -
        optionIndex(column, right as string)
      );
    case 'multiSelect':
    case 'person':
    case 'page': {
      const a = (left as string[])
        .map((id) => optionIndex(column, id))
        .sort((x, y) => x - y);
      const b = (right as string[])
        .map((id) => optionIndex(column, id))
        .sort((x, y) => x - y);
      for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
        if (a[i] !== b[i]) return a[i] - b[i];
      }
      return a.length - b.length;
    }
    case 'date':
      return (left as string) < (right as string) ? -1 : left === right ? 0 : 1;
    default:
      return compareText(String(left), String(right));
  }
}

/** Stable multi-level sort; empty values go last in both directions. */
export function sortDatabaseRows(
  rows: DatabaseRowData[],
  columns: DatabaseColumn[],
  sorts: DatabaseSort[],
): DatabaseRowData[] {
  const byId = new Map(columns.map((column) => [column.id, column]));
  const active = sorts
    .map((sort) => ({ sort, column: byId.get(sort.columnId) }))
    .filter(
      (item): item is { sort: DatabaseSort; column: DatabaseColumn } =>
        !!item.column,
    );
  if (!active.length) return rows;

  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      for (const { sort, column } of active) {
        const left = readDatabaseValue(column, a.row);
        const right = readDatabaseValue(column, b.row);
        const leftEmpty =
          column.type !== 'checkbox' && isDatabaseValueEmpty(column.type, left);
        const rightEmpty =
          column.type !== 'checkbox' &&
          isDatabaseValueEmpty(column.type, right);
        if (leftEmpty || rightEmpty) {
          if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
          continue;
        }
        const result = compareValues(column, left, right);
        if (result !== 0) return sort.direction === 'desc' ? -result : result;
      }
      return a.index - b.index;
    })
    .map((item) => item.row);
}

// ---------------------------------------------------------------- filtering

function matchCondition(
  condition: DatabaseFilterCondition,
  column: DatabaseColumn,
  row: DatabaseRowData,
  locale?: string,
): boolean {
  const value = readDatabaseValue(column, row);
  const empty = isDatabaseValueEmpty(column.type, value);
  const target = condition.value;

  switch (condition.op) {
    case 'isEmpty':
      return empty;
    case 'isNotEmpty':
      return !empty;
    case 'isChecked':
      return value === true;
    case 'isUnchecked':
      return value !== true;
  }

  // An incomplete condition is ignored rather than hiding every row.
  if (
    target === null ||
    target === '' ||
    (Array.isArray(target) && !target.length)
  ) {
    return true;
  }

  switch (column.type) {
    case 'number': {
      if (value === null) return condition.op === 'neq';
      const a = value as number;
      const b = target as number;
      switch (condition.op) {
        case 'eq':
          return a === b;
        case 'neq':
          return a !== b;
        case 'gt':
          return a > b;
        case 'gte':
          return a >= b;
        case 'lt':
          return a < b;
        case 'lte':
          return a <= b;
      }
      return true;
    }
    case 'date': {
      if (value === null) return false;
      const a = value as string;
      const b = target as string;
      switch (condition.op) {
        case 'is':
          return a === b;
        case 'before':
          return a < b;
        case 'after':
          return a > b;
        case 'onOrBefore':
          return a <= b;
        case 'onOrAfter':
          return a >= b;
      }
      return true;
    }
    case 'select': {
      const ids = target as string[];
      if (condition.op === 'isAnyOf') return ids.includes(value as string);
      if (condition.op === 'isNoneOf') return !ids.includes(value as string);
      return true;
    }
    case 'multiSelect':
    case 'person':
    case 'page': {
      const ids = target as string[];
      const values = value as string[];
      if (condition.op === 'hasAnyOf')
        return ids.some((id) => values.includes(id));
      if (condition.op === 'hasAllOf')
        return ids.every((id) => values.includes(id));
      if (condition.op === 'hasNoneOf')
        return !ids.some((id) => values.includes(id));
      return true;
    }
    default: {
      const a = getDatabaseCellText(column, value, locale).toLowerCase();
      const b = String(target).toLowerCase();
      switch (condition.op) {
        case 'contains':
          return a.includes(b);
        case 'notContains':
          return !a.includes(b);
        case 'is':
          return a === b;
        case 'isNot':
          return a !== b;
        case 'startsWith':
          return a.startsWith(b);
        case 'endsWith':
          return a.endsWith(b);
      }
      return true;
    }
  }
}

export function matchDatabaseFilter(
  filter: DatabaseFilterGroup,
  columns: DatabaseColumn[],
  row: DatabaseRowData,
  locale?: string,
): boolean {
  if (!filter.conditions.length) return true;
  const byId = new Map(columns.map((column) => [column.id, column]));
  const results = filter.conditions.map((item) => {
    if (item.type === 'group')
      return matchDatabaseFilter(item, columns, row, locale);
    const column = byId.get(item.columnId);
    return column ? matchCondition(item, column, row, locale) : true;
  });
  return filter.mode === 'or' ? results.some(Boolean) : results.every(Boolean);
}

/** Case-insensitive search over the text of every column. */
export function matchDatabaseSearch(
  query: string,
  columns: DatabaseColumn[],
  row: DatabaseRowData,
  locale?: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return columns.some((column) =>
    getDatabaseCellText(column, row.values[column.id] ?? null, locale)
      .toLowerCase()
      .includes(needle),
  );
}

/**
 * Values for a row created inside a filtered view, so it stays visible:
 * only top-level AND conditions with an unambiguous value are used.
 */
export function getDatabaseFilterDefaults(
  filter: DatabaseFilterGroup,
  columns: DatabaseColumn[],
): Record<string, DatabaseCellValue> {
  if (filter.mode !== 'and') return {};
  const byId = new Map(columns.map((column) => [column.id, column]));
  const counts = new Map<string, number>();
  for (const item of filter.conditions) {
    if (item.type === 'condition') {
      counts.set(item.columnId, (counts.get(item.columnId) ?? 0) + 1);
    }
  }
  const values: Record<string, DatabaseCellValue> = {};
  for (const item of filter.conditions) {
    if (item.type !== 'condition' || counts.get(item.columnId) !== 1) continue;
    const column = byId.get(item.columnId);
    if (!column) continue;
    const target = item.value;
    let value: DatabaseCellValue | undefined;
    switch (item.op) {
      case 'isChecked':
        value = true;
        break;
      case 'is':
      case 'contains':
      case 'startsWith':
      case 'endsWith':
      case 'eq':
      case 'gte':
      case 'lte':
      case 'onOrAfter':
      case 'onOrBefore':
        value = target as DatabaseCellValue;
        break;
      case 'gt':
        value = typeof target === 'number' ? target + 1 : undefined;
        break;
      case 'lt':
        value = typeof target === 'number' ? target - 1 : undefined;
        break;
      case 'after':
        value = isDatabaseDate(target) ? addDatabaseDays(target, 1) : undefined;
        break;
      case 'before':
        value = isDatabaseDate(target)
          ? addDatabaseDays(target, -1)
          : undefined;
        break;
      case 'isAnyOf':
        value =
          Array.isArray(target) && target.length === 1 ? target[0] : undefined;
        break;
      case 'hasAnyOf':
      case 'hasAllOf':
        value = Array.isArray(target) ? target : undefined;
        break;
    }
    if (value !== undefined && value !== null && value !== '') {
      values[column.id] = normalizeDatabaseCellValue(column.type, value);
    }
  }
  return values;
}

// ---------------------------------------------------------------- grouping

export interface DatabaseGroup {
  key: string;
  /** Option for select/multiSelect groups; null for the empty and checkbox groups. */
  option: DatabaseSelectOption | null;
  rows: DatabaseRowData[];
}

/** Group keys a row belongs to. A multiSelect row appears in every group it has. */
export function getDatabaseRowGroupKeys(
  column: DatabaseColumn,
  row: DatabaseRowData,
): string[] {
  const value = normalizeDatabaseCellValue(
    column.type,
    row.values[column.id] ?? null,
  );
  if (column.type === 'checkbox') {
    return [value === true ? DATABASE_CHECKED_GROUP : DATABASE_UNCHECKED_GROUP];
  }
  const known = new Set(column.options?.map((option) => option.id));
  const ids = (
    isDatabaseMultiValue(column.type)
      ? (value as string[])
      : value
        ? [value as string]
        : []
  ).filter((id) => known.has(id));
  return ids.length ? ids : [DATABASE_EMPTY_GROUP];
}

function naturalGroupKeys(column: DatabaseColumn): string[] {
  if (column.type === 'checkbox')
    return [DATABASE_UNCHECKED_GROUP, DATABASE_CHECKED_GROUP];
  return [
    ...(column.options ?? []).map((option) => option.id),
    DATABASE_EMPTY_GROUP,
  ];
}

function orderByIds<T extends { id: string }>(
  items: T[],
  order: string[] | undefined,
): T[] {
  if (!order?.length) return items;
  const rank = new Map(order.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, index, rank: rank.get(item.id) }))
    .sort((a, b) => {
      if (a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank;
      if (a.rank !== undefined) return -1;
      if (b.rank !== undefined) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

/**
 * Every group in display order, including hidden and empty ones (callers
 * decide what to show), except members and documents no row references.
 * Rows keep their incoming order; without sorts, the view's manual card order
 * is applied per group.
 */
export function groupDatabaseRows(
  rows: DatabaseRowData[],
  column: DatabaseColumn,
  view: Pick<DatabaseView, 'groupOrder' | 'cardOrder' | 'sorts'>,
): DatabaseGroup[] {
  const optionById = new Map(
    column.options?.map((option) => [option.id, option]),
  );
  const natural = naturalGroupKeys(column);
  const rank = new Map(view.groupOrder.map((key, index) => [key, index]));
  const keys = natural
    .map((key, index) => ({ key, index, rank: rank.get(key) }))
    .sort((a, b) => {
      if (a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank;
      if (a.rank !== undefined) return -1;
      if (b.rank !== undefined) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.key);

  const groups = new Map<string, DatabaseGroup>(
    keys.map((key) => [
      key,
      { key, option: optionById.get(key) ?? null, rows: [] },
    ]),
  );
  for (const row of rows) {
    for (const key of getDatabaseRowGroupKeys(column, row)) {
      groups.get(key)?.rows.push(row);
    }
  }
  if (!view.sorts.length) {
    for (const group of groups.values()) {
      group.rows = orderByIds(group.rows, view.cardOrder[group.key]);
    }
  }
  // A member or document is only a group while some row references it.
  const result = keys.map((key) => groups.get(key)!);
  return isDatabaseReference(column.type)
    ? result.filter(
        (group) => group.key === DATABASE_EMPTY_GROUP || group.rows.length > 0,
      )
    : result;
}

/** The cell value after moving a row from one group to another. */
export function getDatabaseGroupMoveValue(
  column: DatabaseColumn,
  current: DatabaseCellValue,
  fromKey: string,
  toKey: string,
): DatabaseCellValue {
  switch (column.type) {
    case 'checkbox':
      return toKey === DATABASE_CHECKED_GROUP;
    case 'select':
      return toKey === DATABASE_EMPTY_GROUP ? null : toKey;
    case 'multiSelect':
    case 'person':
    case 'page': {
      if (toKey === DATABASE_EMPTY_GROUP) return [];
      const values = (
        normalizeDatabaseCellValue(column.type, current) as string[]
      ).filter((id) => id !== fromKey);
      return values.includes(toKey) ? values : [...values, toKey];
    }
    default:
      return current;
  }
}

// ---------------------------------------------------------------- conversion

function textToOptionNames(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,，]/)
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
}

/** Plain text of a value, for conversions; checkbox becomes Yes/No. */
function valueToPlainText(
  column: DatabaseColumn,
  value: DatabaseCellValue,
): string {
  if (column.type === 'checkbox') {
    return normalizeDatabaseCellValue('checkbox', value) ? 'Yes' : 'No';
  }
  if (column.type === 'number') {
    const number = normalizeDatabaseCellValue('number', value);
    return number === null ? '' : String(number);
  }
  return getDatabaseCellText(column, value);
}

const TRUTHY = new Set(['yes', 'true', '1', 'y', '✓', 'x', '是', '对']);

/**
 * The column after changing its type, and a function mapping each existing
 * value to the new type. select ↔ multiSelect keep their options; other
 * conversions into select types create options from the text values.
 */
export function convertDatabaseColumn(
  column: DatabaseColumn,
  type: DatabaseColumnType,
  values: DatabaseCellValue[],
): {
  column: DatabaseColumn;
  convert: (value: DatabaseCellValue) => DatabaseCellValue;
} {
  const next: DatabaseColumn = { id: column.id, name: column.name, type };
  const fromSelect = column.type === 'select' || column.type === 'multiSelect';

  // Text cannot be matched to members or documents, so a reference column starts empty.
  if (isDatabaseReference(type)) {
    next.options = [];
    return { column: next, convert: () => [] };
  }

  if (type === 'select' || type === 'multiSelect') {
    if (fromSelect) {
      next.options = column.options ?? [];
    } else {
      const options: DatabaseSelectOption[] = [];
      const byName = new Map<string, string>();
      for (const value of values) {
        for (const name of textToOptionNames(valueToPlainText(column, value))) {
          const key = name.toLowerCase();
          if (byName.has(key)) continue;
          const option = {
            id: generateNodeId(),
            name,
            color: nextDatabaseOptionColor(options),
          };
          options.push(option);
          byName.set(key, option.id);
        }
      }
      next.options = options;
      return {
        column: next,
        convert: (value) => {
          const ids = textToOptionNames(valueToPlainText(column, value))
            .map((name) => byName.get(name.toLowerCase())!)
            .filter(Boolean);
          return type === 'select' ? (ids[0] ?? null) : ids;
        },
      };
    }
  }
  if (type === 'number') {
    next.format = column.format ?? 'number';
    next.decimals = column.decimals ?? null;
  }

  const convert = (value: DatabaseCellValue): DatabaseCellValue => {
    const current = normalizeDatabaseCellValue(column.type, value);
    if (fromSelect && (type === 'select' || type === 'multiSelect')) {
      const ids = Array.isArray(current)
        ? current
        : current
          ? [current as string]
          : [];
      return type === 'select' ? (ids[0] ?? null) : ids;
    }
    const text = valueToPlainText(column, current).trim();
    switch (type) {
      case 'text':
      case 'url':
        return text;
      case 'number':
        return normalizeDatabaseCellValue(
          type,
          parseDatabaseNumber(text, 'en-US'),
        );
      case 'checkbox':
        return TRUTHY.has(text.toLowerCase());
      case 'date': {
        const date = text.replace(/[/.]/g, '-').replace(/-(\d)(?!\d)/g, '-0$1');
        return isDatabaseDate(date) ? date : null;
      }
      default:
        return null;
    }
  };
  return { column: next, convert };
}
