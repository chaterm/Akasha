import { useMemo } from "react";
import type { Transaction } from "@tiptap/pm/state";
import {
  DATABASE_EMPTY_GROUP,
  getDatabaseFilterDefaults,
  getDatabaseGroupMoveValue,
  getDatabaseViewColumns,
  groupDatabaseRows,
  insertDatabaseRow,
  matchDatabaseFilter,
  matchDatabaseSearch,
  sortDatabaseRows,
  updateDatabaseView,
  type DatabaseAlign,
  type DatabaseCellValue,
  type DatabaseColumn,
  type DatabaseGroup,
  type DatabaseRowData,
  type DatabaseFilterGroup,
  type DatabaseView,
  type DatabaseViewPatch,
} from "@docmost/editor-ext";

export interface DatabaseFilterDraft {
  dirty: boolean;
  change: (filter: DatabaseFilterGroup) => void;
  reset: () => void;
  save: () => void;
  saveAsView: () => void;
}

export interface DatabaseContext {
  columns: DatabaseColumn[];
  rows: DatabaseRowData[];
  views: DatabaseView[];
  view: DatabaseView;
  filterDraft?: DatabaseFilterDraft;
  editable: boolean;
  locale: string;
  search: string;
  apply: (build: (tr: Transaction, dbPos: number) => unknown) => void;
  openRow: (rowId: string) => void;
  setActiveView: (viewId: string) => void;
  prepareRow?: (
    tr: Transaction,
    pos: number,
  ) => Record<string, DatabaseCellValue>;
}

export function patchView(db: DatabaseContext, patch: DatabaseViewPatch) {
  db.apply((tr, pos) => updateDatabaseView(tr, pos, db.view.id, patch));
}

export function setColumnSort(
  db: DatabaseContext,
  columnId: string,
  direction: "asc" | "desc",
) {
  const sorts = db.view.sorts;
  const next = sorts.some((sort) => sort.columnId === columnId)
    ? sorts.map((sort) =>
        sort.columnId === columnId ? { ...sort, direction } : sort,
      )
    : [...sorts, { columnId, direction }];
  patchView(db, { sorts: next });
}

export function createRow(
  db: DatabaseContext,
  options: {
    values?: Record<string, DatabaseCellValue>;
    beforeRowId?: string | null;
    afterRowId?: string | null;
  } = {},
  extra?: (tr: Transaction, pos: number, rowId: string) => void,
): string {
  let id = "";
  db.apply((tr, pos) => {
    id = insertDatabaseRow(tr, pos, {
      ...options,
      values: {
        ...getDatabaseFilterDefaults(db.view.filter, db.columns),
        ...db.prepareRow?.(tr, pos),
        ...options.values,
      },
    });
    extra?.(tr, pos, id);
  });
  return id;
}

export function columnAlign(
  db: Pick<DatabaseContext, "view">,
  column: DatabaseColumn,
): DatabaseAlign {
  return (
    db.view.columns.find((entry) => entry.id === column.id)?.align ?? "left"
  );
}

export function visibleColumns(db: Pick<DatabaseContext, "columns" | "view">) {
  return getDatabaseViewColumns(db.columns, db.view);
}

export function useViewRows(db: DatabaseContext): DatabaseRowData[] {
  const { rows, columns, view, search, locale } = db;
  return useMemo(() => {
    const filtered = rows.filter(
      (row) =>
        matchDatabaseFilter(view.filter, columns, row, locale) &&
        matchDatabaseSearch(search, columns, row, locale),
    );
    return sortDatabaseRows(filtered, columns, view.sorts);
  }, [rows, columns, view.filter, view.sorts, search, locale]);
}

export function ownsEvent(event: {
  target: EventTarget;
  currentTarget: EventTarget;
}): boolean {
  return (event.currentTarget as Node).contains(event.target as Node);
}

const stop = (event: { stopPropagation: () => void }) =>
  event.stopPropagation();

export const stopBubbling = {
  onClick: stop,
  onMouseDown: stop,
  onPointerDown: stop,
  onKeyDown: stop,
  onDoubleClick: stop,
  onContextMenu: stop,
};

export function isTextTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return (
    element.isContentEditable ||
    element.tagName === "TEXTAREA" ||
    (element.tagName === "INPUT" &&
      !["checkbox", "radio", "button"].includes(
        (element as HTMLInputElement).type,
      ))
  );
}

export function useViewGroups(
  db: DatabaseContext,
  rows: DatabaseRowData[],
): { column: DatabaseColumn; groups: DatabaseGroup[] } | null {
  const { view, columns } = db;
  const column = columns.find((item) => item.id === view.groupBy);
  return useMemo(() => {
    if (!column) return null;
    const hidden = new Set(view.hiddenGroups);
    const groups = groupDatabaseRows(rows, column, view).filter(
      (group) =>
        !hidden.has(group.key) &&
        (group.rows.length > 0 ||
          (group.key !== DATABASE_EMPTY_GROUP && !view.hideEmptyGroups)),
    );
    return { column, groups };
  }, [rows, column, view]);
}

export function groupValues(
  column: DatabaseColumn,
  group: DatabaseGroup,
): Record<string, DatabaseCellValue> {
  return {
    [column.id]: getDatabaseGroupMoveValue(
      column,
      null,
      DATABASE_EMPTY_GROUP,
      group.key,
    ),
  };
}

export function isDateView(view: Pick<DatabaseView, "type">) {
  return (
    view.type === "calendar" ||
    view.type === "timeline" ||
    view.type === "agenda"
  );
}

export function isTableView(view: Pick<DatabaseView, "type">) {
  return view.type === "table" || view.type === "mine";
}

export function rowsOf(
  db: Pick<DatabaseContext, "columns" | "rows">,
  userId: string | undefined,
): DatabaseRowData[] {
  const people = db.columns.filter((column) => column.type === "person");
  if (!userId || !people.length) return [];
  return db.rows.filter((row) =>
    people.some((column) => {
      const value = row.values[column.id];
      return Array.isArray(value) && value.includes(userId);
    }),
  );
}
