/**
 * Database block data shapes and their normalizers.
 *
 * Every attr read from the document goes through a normalizer, so old
 * documents, concurrent edits and hand-written HTML all collapse into one
 * valid shape. Normalizers are deterministic: they never generate ids.
 */

export type DatabaseColumnType =
  | 'text'
  | 'number'
  | 'select'
  | 'multiSelect'
  | 'person'
  | 'page'
  | 'date'
  | 'checkbox'
  | 'url';

export const DATABASE_COLUMN_TYPES: readonly DatabaseColumnType[] = [
  'text',
  'number',
  'select',
  'multiSelect',
  'person',
  'page',
  'date',
  'checkbox',
  'url',
];

export type DatabaseColor =
  | 'gray'
  | 'red'
  | 'pink'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'teal'
  | 'cyan'
  | 'blue'
  | 'purple';

export const DATABASE_COLORS: readonly DatabaseColor[] = [
  'gray',
  'red',
  'pink',
  'orange',
  'yellow',
  'green',
  'teal',
  'cyan',
  'blue',
  'purple',
];

/** Order in which new options pick colors; gray is the last resort. */
const OPTION_COLOR_PREFERENCE: readonly DatabaseColor[] = [
  'blue',
  'green',
  'yellow',
  'orange',
  'red',
  'pink',
  'purple',
  'teal',
  'cyan',
  'gray',
];

/**
 * A select option. For reference columns it is the referenced item: person =
 * a member (id = user id) with cached name and avatar; page = a document,
 * stored as its page id only. The client fills in a page's title, icon and
 * link from a permission-checked lookup and marks it `unavailable` when the
 * viewer cannot see it; those fields are never written back.
 */
export interface DatabaseSelectOption {
  id: string;
  name: string;
  color: DatabaseColor;
  avatarUrl?: string;
  icon?: string;
  slugId?: string;
  spaceSlug?: string;
  unavailable?: boolean;
}

/** Columns that reference members or documents instead of their own options. */
export function isDatabaseReference(type: DatabaseColumnType): boolean {
  return type === 'person' || type === 'page';
}

/** Column types whose value is a list of option ids. */
export function isDatabaseMultiValue(type: DatabaseColumnType): boolean {
  return type === 'multiSelect' || isDatabaseReference(type);
}

/** Column types whose values reference `column.options`. */
export function hasDatabaseOptions(type: DatabaseColumnType): boolean {
  return type === 'select' || isDatabaseMultiValue(type);
}

export type DatabaseNumberFormat =
  | 'number'
  | 'commas'
  | 'percent'
  | 'CNY'
  | 'USD'
  | 'EUR'
  | 'GBP'
  | 'JPY';

export const DATABASE_NUMBER_FORMATS: readonly DatabaseNumberFormat[] = [
  'number',
  'commas',
  'percent',
  'CNY',
  'USD',
  'EUR',
  'GBP',
  'JPY',
];

export interface DatabaseColumn {
  id: string;
  name: string;
  type: DatabaseColumnType;
  /** select / multiSelect */
  options?: DatabaseSelectOption[];
  /** number */
  format?: DatabaseNumberFormat;
  /** number: fixed fraction digits, null = as entered */
  decimals?: number | null;
}

/**
 * Value stored per type:
 * text/url: string, number: number,
 * select: option id, multiSelect: option ids, person: user ids, date: YYYY-MM-DD, checkbox: boolean.
 */
export type DatabaseCellValue = string | number | boolean | string[] | null;

export interface DatabaseRowData {
  id: string;
  values: Record<string, DatabaseCellValue>;
}

/** `mine` is a table of the rows that reference the viewer in a member column. */
export type DatabaseViewType =
  | 'table'
  | 'kanban'
  | 'calendar'
  | 'timeline'
  | 'mine';

export const DATABASE_VIEW_TYPES: readonly DatabaseViewType[] = [
  'table',
  'kanban',
  'calendar',
  'timeline',
  'mine',
];

export type DatabaseAlign = 'left' | 'center' | 'right';

export const DATABASE_ALIGNS: readonly DatabaseAlign[] = [
  'left',
  'center',
  'right',
];

export function normalizeDatabaseAlign(value: unknown): DatabaseAlign | null {
  return DATABASE_ALIGNS.includes(value as DatabaseAlign)
    ? (value as DatabaseAlign)
    : null;
}

/** Per-view column order, width, alignment and visibility. */
export interface DatabaseViewColumn {
  id: string;
  width: number | null;
  /** null = the column type's default. */
  align: DatabaseAlign | null;
  hidden: boolean;
}

export interface DatabaseSort {
  columnId: string;
  direction: 'asc' | 'desc';
}

export type DatabaseFilterOperator =
  | 'contains'
  | 'notContains'
  | 'is'
  | 'isNot'
  | 'startsWith'
  | 'endsWith'
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'before'
  | 'after'
  | 'onOrBefore'
  | 'onOrAfter'
  | 'isAnyOf'
  | 'isNoneOf'
  | 'hasAnyOf'
  | 'hasAllOf'
  | 'hasNoneOf'
  | 'isChecked'
  | 'isUnchecked'
  | 'isEmpty'
  | 'isNotEmpty';

export interface DatabaseFilterCondition {
  type: 'condition';
  columnId: string;
  op: DatabaseFilterOperator;
  /** string for text ops, number for number ops, YYYY-MM-DD for date ops, option ids for select ops. */
  value: string | number | string[] | null;
}

export interface DatabaseFilterGroup {
  type: 'group';
  mode: 'and' | 'or';
  conditions: (DatabaseFilterCondition | DatabaseFilterGroup)[];
}

export interface DatabaseView {
  id: string;
  name: string;
  type: DatabaseViewType;
  /** Table / kanban: horizontal placement of the whole view. */
  align: DatabaseAlign;
  /** Kanban: groups as columns (vertical) or as rows of cards (horizontal). */
  orientation: 'vertical' | 'horizontal';
  /** Table: leading row-number column, counted in the view's row order. */
  showRowNumbers: boolean;
  columns: DatabaseViewColumn[];
  sorts: DatabaseSort[];
  filter: DatabaseFilterGroup;
  /** Kanban: select, multiSelect or checkbox column. */
  groupBy: string | null;
  /** Kanban: group keys in display order; groups not listed follow in natural order. */
  groupOrder: string[];
  hiddenGroups: string[];
  hideEmptyGroups: boolean;
  /** Kanban: manual card order per group key, used while the view has no sorts. */
  cardOrder: Record<string, string[]>;
  /** Calendar / timeline: start date column. */
  dateColumnId: string | null;
  /** Calendar: optional end date column; rows with a later end render as multi-day bars. */
  endDateColumnId: string | null;
}

/** Group key for rows without a value (select / multiSelect / person / page). */
export const DATABASE_EMPTY_GROUP = '__empty';
export const DATABASE_CHECKED_GROUP = 'checked';
export const DATABASE_UNCHECKED_GROUP = 'unchecked';

export const DATABASE_GROUPABLE_TYPES: readonly DatabaseColumnType[] = [
  'select',
  'multiSelect',
  'person',
  'page',
  'checkbox',
];

export const DATABASE_MIN_COLUMN_WIDTH = 80;
const MAX_COLUMN_WIDTH = 1200;
const MAX_FILTER_DEPTH = 3;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (item): item is string => typeof item === 'string' && !!item,
      ),
    ),
  ];
}

export function isDatabaseDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function normalizeDatabaseColor(value: unknown): DatabaseColor {
  return DATABASE_COLORS.includes(value as DatabaseColor)
    ? (value as DatabaseColor)
    : 'gray';
}

/** The least used color among existing options, by preference order. */
export function nextDatabaseOptionColor(
  options: DatabaseSelectOption[],
): DatabaseColor {
  const counts = new Map<DatabaseColor, number>();
  for (const option of options) {
    counts.set(option.color, (counts.get(option.color) ?? 0) + 1);
  }
  let best = OPTION_COLOR_PREFERENCE[0];
  for (const color of OPTION_COLOR_PREFERENCE) {
    if ((counts.get(color) ?? 0) < (counts.get(best) ?? 0)) best = color;
  }
  return best;
}

function normalizeOptions(value: unknown): DatabaseSelectOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: DatabaseSelectOption[] = [];
  for (const raw of value) {
    const id = asString(raw?.id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const option: DatabaseSelectOption = {
      id,
      name: asString(raw?.name),
      color: normalizeDatabaseColor(raw?.color),
    };
    for (const key of ['avatarUrl', 'icon', 'slugId', 'spaceSlug'] as const) {
      if (typeof raw?.[key] === 'string' && raw[key]) option[key] = raw[key];
    }
    options.push(option);
  }
  return options;
}

export function normalizeDatabaseDecimals(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number)) return null;
  return Math.min(Math.max(number, 0), 8);
}

function normalizeColumn(item: any, type: DatabaseColumnType): DatabaseColumn {
  const column: DatabaseColumn = {
    id: asString(item?.id).trim(),
    name: asString(item?.name),
    type,
  };
  if (hasDatabaseOptions(type)) {
    column.options = normalizeOptions(item?.options);
  }
  // Only the page id is stored: titles are looked up with each viewer's permissions.
  if (type === 'page') {
    column.options = column.options!.map(({ id, color }) => ({
      id,
      name: '',
      color,
    }));
  }
  if (type === 'number') {
    column.format = DATABASE_NUMBER_FORMATS.includes(item?.format)
      ? item.format
      : 'number';
    column.decimals = normalizeDatabaseDecimals(item?.decimals);
  }
  return column;
}

/** Drops malformed columns; unknown types (including the old `title`) become text. Never empty. */
export function normalizeDatabaseColumns(value: unknown): DatabaseColumn[] {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const columns: DatabaseColumn[] = [];

  for (const item of raw) {
    const id = asString(item?.id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const type: DatabaseColumnType = DATABASE_COLUMN_TYPES.includes(item?.type)
      ? item.type
      : 'text';
    columns.push(normalizeColumn(item, type));
  }

  return columns.length ? columns : [{ id: 'text', name: 'Text', type: 'text' }];
}

export function normalizeDatabaseCellValue(
  type: DatabaseColumnType,
  value: unknown,
): DatabaseCellValue {
  switch (type) {
    case 'text':
    case 'url':
      return typeof value === 'string' ? value : '';
    case 'number': {
      if (value === '' || value === null || value === undefined) return null;
      const number = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(number) ? number : null;
    }
    case 'select':
      return typeof value === 'string' && value ? value : null;
    case 'multiSelect':
    case 'person':
    case 'page':
      return uniqueStrings(value);
    case 'date':
      return isDatabaseDate(value) ? value : null;
    case 'checkbox':
      return value === true;
  }
}

export function isDatabaseValueEmpty(
  type: DatabaseColumnType,
  value: DatabaseCellValue,
): boolean {
  const normalized = normalizeDatabaseCellValue(type, value);
  if (type === 'checkbox') return normalized !== true;
  if (Array.isArray(normalized)) return normalized.length === 0;
  return normalized === null || normalized === '';
}

const TEXT_OPERATORS: DatabaseFilterOperator[] = [
  'contains',
  'notContains',
  'is',
  'isNot',
  'startsWith',
  'endsWith',
  'isEmpty',
  'isNotEmpty',
];
const NUMBER_OPERATORS: DatabaseFilterOperator[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'isEmpty',
  'isNotEmpty',
];
const DATE_OPERATORS: DatabaseFilterOperator[] = [
  'is',
  'before',
  'after',
  'onOrBefore',
  'onOrAfter',
  'isEmpty',
  'isNotEmpty',
];
const SELECT_OPERATORS: DatabaseFilterOperator[] = [
  'isAnyOf',
  'isNoneOf',
  'isEmpty',
  'isNotEmpty',
];
const MULTI_SELECT_OPERATORS: DatabaseFilterOperator[] = [
  'hasAnyOf',
  'hasAllOf',
  'hasNoneOf',
  'isEmpty',
  'isNotEmpty',
];
const CHECKBOX_OPERATORS: DatabaseFilterOperator[] = [
  'isChecked',
  'isUnchecked',
];

export function getDatabaseFilterOperators(
  type: DatabaseColumnType,
): DatabaseFilterOperator[] {
  switch (type) {
    case 'number':
      return NUMBER_OPERATORS;
    case 'date':
      return DATE_OPERATORS;
    case 'select':
      return SELECT_OPERATORS;
    case 'multiSelect':
    case 'person':
    case 'page':
      return MULTI_SELECT_OPERATORS;
    case 'checkbox':
      return CHECKBOX_OPERATORS;
    default:
      return TEXT_OPERATORS;
  }
}

export function databaseFilterNeedsValue(op: DatabaseFilterOperator): boolean {
  return !['isEmpty', 'isNotEmpty', 'isChecked', 'isUnchecked'].includes(op);
}

function normalizeFilterValue(
  type: DatabaseColumnType,
  op: DatabaseFilterOperator,
  value: unknown,
): DatabaseFilterCondition['value'] {
  if (!databaseFilterNeedsValue(op)) return null;
  switch (type) {
    case 'number': {
      if (value === '' || value === null || value === undefined) return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }
    case 'date':
      return isDatabaseDate(value) ? value : null;
    case 'select':
    case 'multiSelect':
    case 'person':
    case 'page':
      return uniqueStrings(value);
    default:
      return typeof value === 'string' ? value : '';
  }
}

export function emptyDatabaseFilter(): DatabaseFilterGroup {
  return { type: 'group', mode: 'and', conditions: [] };
}

/** Drops conditions on missing columns or with operators the column type does not support. */
export function normalizeDatabaseFilter(
  value: unknown,
  columns: DatabaseColumn[],
  depth = 1,
): DatabaseFilterGroup {
  const raw = value as any;
  if (!raw || raw.type !== 'group' || !Array.isArray(raw.conditions)) {
    return emptyDatabaseFilter();
  }
  const byId = new Map(columns.map((column) => [column.id, column]));
  const conditions: DatabaseFilterGroup['conditions'] = [];
  for (const item of raw.conditions) {
    if (item?.type === 'group') {
      if (depth < MAX_FILTER_DEPTH) {
        conditions.push(normalizeDatabaseFilter(item, columns, depth + 1));
      }
      continue;
    }
    if (item?.type !== 'condition') continue;
    const column = byId.get(item.columnId);
    if (!column) continue;
    const op = item.op as DatabaseFilterOperator;
    if (!getDatabaseFilterOperators(column.type).includes(op)) continue;
    conditions.push({
      type: 'condition',
      columnId: column.id,
      op,
      value: normalizeFilterValue(column.type, op, item.value),
    });
  }
  return { type: 'group', mode: raw.mode === 'or' ? 'or' : 'and', conditions };
}

export function countDatabaseFilterConditions(
  filter: DatabaseFilterGroup,
): number {
  return filter.conditions.reduce(
    (count, item) =>
      count + (item.type === 'group' ? countDatabaseFilterConditions(item) : 1),
    0,
  );
}

function normalizeViewColumns(
  raw: any,
  columns: DatabaseColumn[],
): DatabaseViewColumn[] {
  const byId = new Map(columns.map((column) => [column.id, column]));
  const legacyHidden = new Set(uniqueStrings(raw?.hiddenColumnIds));
  const entries: DatabaseViewColumn[] = [];
  const seen = new Set<string>();

  if (Array.isArray(raw?.columns)) {
    for (const item of raw.columns) {
      const id = asString(item?.id);
      if (!byId.has(id) || seen.has(id)) continue;
      seen.add(id);
      const width = Number(item?.width);
      entries.push({
        id,
        width:
          Number.isFinite(width) && width > 0
            ? Math.min(
                Math.max(Math.round(width), DATABASE_MIN_COLUMN_WIDTH),
                MAX_COLUMN_WIDTH,
              )
            : null,
        align: normalizeDatabaseAlign(item?.align),
        hidden: item?.hidden === true,
      });
    }
  }
  for (const column of columns) {
    if (seen.has(column.id)) continue;
    entries.push({
      id: column.id,
      width: null,
      align: null,
      hidden: legacyHidden.has(column.id),
    });
  }

  return entries;
}

function normalizeSorts(raw: any, columns: DatabaseColumn[]): DatabaseSort[] {
  const ids = new Set(columns.map((column) => column.id));
  const list = Array.isArray(raw?.sorts)
    ? raw.sorts
    : raw?.sort
      ? [raw.sort]
      : [];
  const seen = new Set<string>();
  const sorts: DatabaseSort[] = [];
  for (const item of list) {
    const columnId = asString(item?.columnId);
    if (!ids.has(columnId) || seen.has(columnId)) continue;
    seen.add(columnId);
    sorts.push({
      columnId,
      direction: item?.direction === 'desc' ? 'desc' : 'asc',
    });
  }
  return sorts;
}

function normalizeCardOrder(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(value as Record<string, unknown>)) {
    const list = uniqueStrings(ids);
    if (list.length) result[key] = list;
  }
  return result;
}

export function normalizeDatabaseView(
  item: any,
  columns: DatabaseColumn[],
): DatabaseView {
  const byId = new Map(columns.map((column) => [column.id, column]));
  const ofTypes = (types: readonly DatabaseColumnType[]) =>
    columns.filter((column) => types.includes(column.type));
  const isOfTypes = (id: unknown, types: readonly DatabaseColumnType[]) =>
    typeof id === 'string' &&
    types.includes(byId.get(id)?.type as DatabaseColumnType);
  const type: DatabaseViewType = DATABASE_VIEW_TYPES.includes(item?.type)
    ? item.type
    : 'table';

  // Kanban and calendar cannot work without their column, so they fall back to the first match.
  let groupBy = isOfTypes(item?.groupBy, DATABASE_GROUPABLE_TYPES)
    ? item.groupBy
    : null;
  if (!groupBy && type === 'kanban') {
    groupBy = ofTypes(DATABASE_GROUPABLE_TYPES)[0]?.id ?? null;
  }
  let dateColumnId = isOfTypes(item?.dateColumnId, ['date'])
    ? item.dateColumnId
    : null;
  if (!dateColumnId && (type === 'calendar' || type === 'timeline')) {
    dateColumnId = ofTypes(['date'])[0]?.id ?? null;
  }
  const endDateColumnId =
    isOfTypes(item?.endDateColumnId, ['date']) &&
    item.endDateColumnId !== dateColumnId
      ? item.endDateColumnId
      : null;

  return {
    id: asString(item?.id).trim(),
    name: asString(item?.name),
    type,
    align: normalizeDatabaseAlign(item?.align) ?? 'left',
    orientation: item?.orientation === 'horizontal' ? 'horizontal' : 'vertical',
    showRowNumbers: item?.showRowNumbers !== false,
    columns: normalizeViewColumns(item, columns),
    sorts: normalizeSorts(item, columns),
    filter: normalizeDatabaseFilter(item?.filter, columns),
    groupBy,
    groupOrder: uniqueStrings(item?.groupOrder),
    hiddenGroups: uniqueStrings(item?.hiddenGroups),
    hideEmptyGroups: item?.hideEmptyGroups === true,
    cardOrder: normalizeCardOrder(item?.cardOrder),
    dateColumnId,
    endDateColumnId,
  };
}

export function normalizeDatabaseViews(
  value: unknown,
  columns: DatabaseColumn[],
): DatabaseView[] {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const views: DatabaseView[] = [];
  for (const item of raw) {
    const view = normalizeDatabaseView(item, columns);
    if (!view.id || seen.has(view.id)) continue;
    seen.add(view.id);
    views.push(view);
  }
  if (views.length === 0) {
    views.push(
      normalizeDatabaseView(
        { id: 'table', name: 'Table', type: 'table' },
        columns,
      ),
    );
  }
  return views;
}

/** Visible columns of a view in its order. */
export function getDatabaseViewColumns(
  columns: DatabaseColumn[],
  view: DatabaseView,
): DatabaseColumn[] {
  const byId = new Map(columns.map((column) => [column.id, column]));
  return view.columns
    .filter((entry) => !entry.hidden)
    .map((entry) => byId.get(entry.id))
    .filter((column): column is DatabaseColumn => !!column);
}
