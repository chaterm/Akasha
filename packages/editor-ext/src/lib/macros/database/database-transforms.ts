import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { generateNodeId } from '../../utils';
import { readDatabaseRows } from './database';
import {
  addDatabaseDays,
  convertDatabaseColumn,
  diffDatabaseDays,
  getDatabaseDateRange,
  getDatabaseGroupMoveValue,
  groupDatabaseRows,
} from './database-logic';
import {
  hasDatabaseOptions,
  isDatabaseDate,
  normalizeDatabaseCellValue,
  normalizeDatabaseColumns,
  normalizeDatabaseViews,
  type DatabaseAlign,
  type DatabaseCellValue,
  type DatabaseColumn,
  type DatabaseColumnType,
  type DatabaseView,
} from './database-schema';

function getDatabase(tr: Transaction, dbPos: number): PMNode {
  const node = tr.doc.nodeAt(dbPos);
  if (!node || node.type.name !== 'database') {
    throw new Error(`No database node at ${dbPos}`);
  }
  return node;
}

function getColumns(node: PMNode): DatabaseColumn[] {
  return normalizeDatabaseColumns(node.attrs.columns);
}

function getViews(node: PMNode): DatabaseView[] {
  return normalizeDatabaseViews(node.attrs.views, getColumns(node));
}

function writeSchema(
  tr: Transaction,
  dbPos: number,
  columns: DatabaseColumn[],
  views: unknown[],
): Transaction {
  const normalizedColumns = normalizeDatabaseColumns(columns);
  tr.setNodeAttribute(dbPos, 'columns', normalizedColumns);
  tr.setNodeAttribute(
    dbPos,
    'views',
    normalizeDatabaseViews(views, normalizedColumns),
  );
  return tr;
}

function writeViews(
  tr: Transaction,
  dbPos: number,
  views: unknown[],
): Transaction {
  const db = getDatabase(tr, dbPos);
  return tr.setNodeAttribute(
    dbPos,
    'views',
    normalizeDatabaseViews(views, getColumns(db)),
  );
}

function findRows(
  tr: Transaction,
  dbPos: number,
): { node: PMNode; pos: number }[] {
  const db = getDatabase(tr, dbPos);
  const rows: { node: PMNode; pos: number }[] = [];
  db.forEach((node, offset) => {
    rows.push({ node, pos: dbPos + 1 + offset });
  });
  return rows;
}

function findRow(tr: Transaction, dbPos: number, rowId: string) {
  return findRows(tr, dbPos).find((row) => row.node.attrs.id === rowId) ?? null;
}

function findCellPos(
  row: { node: PMNode; pos: number },
  columnId: string,
): number | null {
  let cellPos: number | null = null;
  row.node.forEach((cell, offset) => {
    if (cellPos === null && cell.attrs.columnId === columnId) {
      cellPos = row.pos + 1 + offset;
    }
  });
  return cellPos;
}

export function insertDatabaseRow(
  tr: Transaction,
  dbPos: number,
  options: {
    id?: string;
    values?: Record<string, DatabaseCellValue>;
    beforeRowId?: string | null;
    afterRowId?: string | null;
  } = {},
): string {
  const db = getDatabase(tr, dbPos);
  const { schema } = tr.doc.type;
  const id = options.id || generateNodeId();
  const cells = getColumns(db)
    .filter((column) => options.values && column.id in options.values)
    .map((column) =>
      schema.nodes.databaseCell.create({
        columnId: column.id,
        value: normalizeDatabaseCellValue(
          column.type,
          options.values![column.id],
        ),
      }),
    );
  const row = schema.nodes.databaseRow.create({ id }, cells);
  const before = options.beforeRowId
    ? findRow(tr, dbPos, options.beforeRowId)
    : null;
  const after =
    !before && options.afterRowId
      ? findRow(tr, dbPos, options.afterRowId)
      : null;
  tr.insert(dbPos + db.nodeSize - 1, row);
  if (before || after) {
    const ids = readDatabaseRows(db).map((item) => item.id);
    const index = before
      ? ids.indexOf(before.node.attrs.id)
      : ids.indexOf(after!.node.attrs.id) + 1;
    ids.splice(index, 0, id);
    tr.setNodeAttribute(dbPos, 'rowOrder', ids);
  }
  return id;
}

export function deleteDatabaseRow(
  tr: Transaction,
  dbPos: number,
  rowId: string,
): Transaction {
  const row = findRow(tr, dbPos, rowId);
  if (row) tr.delete(row.pos, row.pos + row.node.nodeSize);
  return tr;
}

export function moveDatabaseRow(
  tr: Transaction,
  dbPos: number,
  rowId: string,
  beforeRowId: string | null,
): Transaction {
  if (rowId === beforeRowId) return tr;
  const db = getDatabase(tr, dbPos);
  const ids = readDatabaseRows(db).map((row) => row.id);
  const from = ids.indexOf(rowId);
  if (from < 0) return tr;
  ids.splice(from, 1);
  const before = beforeRowId ? ids.indexOf(beforeRowId) : -1;
  ids.splice(before < 0 ? ids.length : before, 0, rowId);
  return tr.setNodeAttribute(dbPos, 'rowOrder', ids);
}

export function setDatabaseCellValue(
  tr: Transaction,
  dbPos: number,
  rowId: string,
  columnId: string,
  value: DatabaseCellValue,
): Transaction {
  const db = getDatabase(tr, dbPos);
  const column = getColumns(db).find((item) => item.id === columnId);
  const row = findRow(tr, dbPos, rowId);
  if (!column || !row) return tr;
  const normalized = normalizeDatabaseCellValue(column.type, value);
  const cellPos = findCellPos(row, columnId);
  if (cellPos !== null) {
    tr.setNodeAttribute(cellPos, 'value', normalized);
  } else {
    tr.insert(
      row.pos + row.node.nodeSize - 1,
      tr.doc.type.schema.nodes.databaseCell.create({
        columnId,
        value: normalized,
      }),
    );
  }
  return tr;
}

export function setDatabaseTitle(
  tr: Transaction,
  dbPos: number,
  title: string,
): Transaction {
  getDatabase(tr, dbPos);
  return tr.setNodeAttribute(dbPos, 'title', title);
}

export function setDatabaseTitleAlign(
  tr: Transaction,
  dbPos: number,
  align: DatabaseAlign,
): Transaction {
  getDatabase(tr, dbPos);
  return tr.setNodeAttribute(dbPos, 'titleAlign', align);
}

function placeColumnInViews(
  views: DatabaseView[],
  columnId: string,
  anchorId: string | null | undefined,
  side: 'left' | 'right',
): DatabaseView[] {
  if (!anchorId) return views;
  return views.map((view) => {
    const entries = view.columns.filter((entry) => entry.id !== columnId);
    const index = entries.findIndex((entry) => entry.id === anchorId);
    if (index < 0) return view;
    const at = side === 'left' ? index : index + 1;
    entries.splice(at, 0, {
      id: columnId,
      width: null,
      align: null,
      hidden: false,
      wrap: false,
    });
    return { ...view, columns: entries };
  });
}

export function addDatabaseColumn(
  tr: Transaction,
  dbPos: number,
  column: Omit<DatabaseColumn, 'id'> & { id?: string },
  position?: { anchorId: string; side: 'left' | 'right' },
): string {
  const db = getDatabase(tr, dbPos);
  const id = column.id || generateNodeId();
  const next: DatabaseColumn = { ...column, id };
  if (hasDatabaseOptions(column.type)) next.options = column.options ?? [];
  const views = placeColumnInViews(
    getViews(db),
    id,
    position?.anchorId,
    position?.side ?? 'right',
  );
  writeSchema(tr, dbPos, [...getColumns(db), next], views);
  return id;
}

export function duplicateDatabaseColumn(
  tr: Transaction,
  dbPos: number,
  columnId: string,
  name: string,
): string | null {
  const db = getDatabase(tr, dbPos);
  const source = getColumns(db).find((column) => column.id === columnId);
  if (!source) return null;
  const id = generateNodeId();
  const copy: DatabaseColumn = {
    ...source,
    id,
    name,
  };
  const values = new Map(
    readDatabaseRows(db).map((row) => [row.id, row.values[columnId]]),
  );
  writeSchema(
    tr,
    dbPos,
    [...getColumns(db), copy],
    placeColumnInViews(getViews(db), id, columnId, 'right'),
  );
  for (const [rowId, value] of values) {
    if (value !== undefined) setDatabaseCellValue(tr, dbPos, rowId, id, value);
  }
  return id;
}

export function changeDatabaseColumnType(
  tr: Transaction,
  dbPos: number,
  columnId: string,
  type: DatabaseColumnType,
): Transaction {
  const db = getDatabase(tr, dbPos);
  const columns = getColumns(db);
  const column = columns.find((item) => item.id === columnId);
  if (!column || column.type === type || column.id === columns[0].id) return tr;
  const rows = readDatabaseRows(db);
  const { column: next, convert } = convertDatabaseColumn(
    column,
    type,
    rows.map((row) => row.values[columnId] ?? null),
  );
  writeSchema(
    tr,
    dbPos,
    columns.map((item) => (item.id === columnId ? next : item)),
    getViews(db),
  );
  for (const row of rows) {
    if (columnId in row.values) {
      setDatabaseCellValue(
        tr,
        dbPos,
        row.id,
        columnId,
        convert(row.values[columnId]),
      );
    }
  }
  return tr;
}

export function updateDatabaseColumn(
  tr: Transaction,
  dbPos: number,
  columnId: string,
  patch: Partial<
    Pick<DatabaseColumn, 'name' | 'options' | 'format' | 'decimals'>
  >,
): Transaction {
  const db = getDatabase(tr, dbPos);
  const columns = getColumns(db).map((column) =>
    column.id === columnId ? { ...column, ...patch } : column,
  );
  return writeSchema(tr, dbPos, columns, getViews(db));
}

export function deleteDatabaseColumn(
  tr: Transaction,
  dbPos: number,
  columnId: string,
): Transaction {
  const db = getDatabase(tr, dbPos);
  const columns = getColumns(db);
  const target = columns.find((column) => column.id === columnId);
  if (!target || target.id === columns[0].id) return tr;

  const cellPositions: { from: number; to: number }[] = [];
  for (const row of findRows(tr, dbPos)) {
    row.node.forEach((cell, offset) => {
      if (cell.attrs.columnId === columnId) {
        const from = row.pos + 1 + offset;
        cellPositions.push({ from, to: from + cell.nodeSize });
      }
    });
  }
  for (const { from, to } of cellPositions.reverse()) tr.delete(from, to);

  return writeSchema(
    tr,
    dbPos,
    columns.filter((column) => column.id !== columnId),
    getViews(db),
  );
}

export function addDatabaseView(
  tr: Transaction,
  dbPos: number,
  view: Partial<DatabaseView> & Pick<DatabaseView, 'name' | 'type'>,
): string {
  const db = getDatabase(tr, dbPos);
  const id = view.id || generateNodeId();
  writeViews(tr, dbPos, [...getViews(db), { ...view, id }]);
  return id;
}

export type DatabaseViewPatch = Partial<Omit<DatabaseView, 'id' | 'type'>>;

export function updateDatabaseView(
  tr: Transaction,
  dbPos: number,
  viewId: string,
  patch: DatabaseViewPatch,
): Transaction {
  const db = getDatabase(tr, dbPos);
  const views = getViews(db).map((view) => {
    if (view.id !== viewId) return view;
    const next = { ...view, ...patch };
    if (patch.groupBy !== undefined && patch.groupBy !== view.groupBy) {
      next.groupOrder = [];
      next.hiddenGroups = [];
      next.collapsedGroups = [];
      next.cardOrder = {};
    }
    return next;
  });
  return writeViews(tr, dbPos, views);
}

export function deleteDatabaseView(
  tr: Transaction,
  dbPos: number,
  viewId: string,
): Transaction {
  const db = getDatabase(tr, dbPos);
  const views = getViews(db);
  if (views.length <= 1) return tr;
  return writeViews(
    tr,
    dbPos,
    views.filter((view) => view.id !== viewId),
  );
}

export function moveDatabaseView(
  tr: Transaction,
  dbPos: number,
  viewId: string,
  beforeViewId: string | null,
): Transaction {
  if (viewId === beforeViewId) return tr;
  const db = getDatabase(tr, dbPos);
  const views = [...getViews(db)];
  const from = views.findIndex((view) => view.id === viewId);
  if (from < 0) return tr;
  const [view] = views.splice(from, 1);
  const to = beforeViewId
    ? views.findIndex((item) => item.id === beforeViewId)
    : views.length;
  if (to < 0 || to === from) return tr;
  views.splice(to, 0, view);
  return writeViews(tr, dbPos, views);
}

export function moveDatabaseCard(
  tr: Transaction,
  dbPos: number,
  viewId: string,
  move: {
    rowId: string;
    fromKey: string;
    toKey: string;
    beforeRowId: string | null;
  },
): Transaction {
  let db = getDatabase(tr, dbPos);
  const columns = getColumns(db);
  const view = getViews(db).find((item) => item.id === viewId);
  const column = view && columns.find((item) => item.id === view.groupBy);
  if (!view || !column) return tr;

  const row = readDatabaseRows(db).find((item) => item.id === move.rowId);
  if (!row) return tr;
  if (move.fromKey !== move.toKey) {
    const value = getDatabaseGroupMoveValue(
      column,
      row.values[column.id] ?? null,
      move.fromKey,
      move.toKey,
    );
    setDatabaseCellValue(tr, dbPos, move.rowId, column.id, value);
    db = getDatabase(tr, dbPos);
  }
  if (view.sorts.length) return tr;

  const rows = readDatabaseRows(db);
  const groups = groupDatabaseRows(rows, column, view);
  const target = groups.find((group) => group.key === move.toKey);
  if (!target) return tr;
  const ids = target.rows
    .map((item) => item.id)
    .filter((id) => id !== move.rowId);
  const at = move.beforeRowId ? ids.indexOf(move.beforeRowId) : -1;
  ids.splice(at < 0 ? ids.length : at, 0, move.rowId);

  const existing = new Set(rows.map((item) => item.id));
  const cardOrder: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(view.cardOrder)) {
    const kept = list.filter((id) => existing.has(id));
    if (kept.length) cardOrder[key] = kept;
  }
  cardOrder[move.toKey] = ids;
  return updateDatabaseView(tr, dbPos, viewId, { cardOrder });
}

export function moveDatabaseRowToDate(
  tr: Transaction,
  dbPos: number,
  viewId: string,
  rowId: string,
  date: string,
): Transaction {
  const db = getDatabase(tr, dbPos);
  const view = getViews(db).find((item) => item.id === viewId);
  const row = readDatabaseRows(db).find((item) => item.id === rowId);
  if (!view?.dateColumnId || !row) return tr;
  const range = getDatabaseDateRange(row, view);
  setDatabaseCellValue(tr, dbPos, rowId, view.dateColumnId, date);
  if (
    range &&
    view.endDateColumnId &&
    isDatabaseDate(row.values[view.endDateColumnId])
  ) {
    const days = diffDatabaseDays(range.start, range.end);
    setDatabaseCellValue(
      tr,
      dbPos,
      rowId,
      view.endDateColumnId,
      addDatabaseDays(date, days),
    );
  }
  return tr;
}

export function resizeDatabaseRowRange(
  tr: Transaction,
  dbPos: number,
  viewId: string,
  rowId: string,
  edge: 'start' | 'end',
  date: string,
): Transaction {
  const db = getDatabase(tr, dbPos);
  const view = getViews(db).find((item) => item.id === viewId);
  const row = readDatabaseRows(db).find((item) => item.id === rowId);
  if (!view?.dateColumnId || !view.endDateColumnId || !row) return tr;
  const range = getDatabaseDateRange(row, view);
  if (!range) return tr;
  if (edge === 'start') {
    setDatabaseCellValue(
      tr,
      dbPos,
      rowId,
      view.dateColumnId,
      date > range.end ? range.end : date,
    );
  } else {
    setDatabaseCellValue(
      tr,
      dbPos,
      rowId,
      view.endDateColumnId,
      date < range.start ? range.start : date,
    );
  }
  return tr;
}
