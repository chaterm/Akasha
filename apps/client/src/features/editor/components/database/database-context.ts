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
  type DatabaseView,
  type DatabaseViewPatch,
} from "@docmost/editor-ext";

/** Everything a view needs: the shared data, the active view, and a way to write. */
export interface DatabaseContext {
  columns: DatabaseColumn[];
  rows: DatabaseRowData[];
  views: DatabaseView[];
  view: DatabaseView;
  editable: boolean;
  locale: string;
  /** Local search text of the active view (not stored in the document). */
  search: string;
  /** Runs `build` against a fresh transaction at the database's current position and dispatches it. */
  apply: (build: (tr: Transaction, dbPos: number) => unknown) => void;
  /** Opens the row detail modal. */
  openRow: (rowId: string) => void;
  setActiveView: (viewId: string) => void;
  /** Extra values for a new row (the "mine" view assigns it to the viewer); may update columns first. */
  prepareRow?: (
    tr: Transaction,
    pos: number,
  ) => Record<string, DatabaseCellValue>;
}

export function patchView(db: DatabaseContext, patch: DatabaseViewPatch) {
  db.apply((tr, pos) => updateDatabaseView(tr, pos, db.view.id, patch));
}

/** Inserts a row pre-filled so it stays visible under the view's filter; returns its id. */
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

/** Alignment of a column in the active view; left unless set. */
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

/** Rows of the active view after filter, search and sorts. */
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

/**
 * React bubbles events from portals (popovers, the row modal) through the
 * component tree; handlers that act on "their" element must ignore those.
 */
export function ownsEvent(event: {
  target: EventTarget;
  currentTarget: EventTarget;
}): boolean {
  return (event.currentTarget as Node).contains(event.target as Node);
}

const stop = (event: { stopPropagation: () => void }) =>
  event.stopPropagation();

/**
 * Spread on every Popover.Dropdown / modal body: keeps their events from
 * bubbling (through the React tree) into the target button, card or cell
 * that owns them. Mantine's own outside-click and Escape handling runs in the
 * capture phase and is unaffected.
 */
export const stopBubbling = {
  onClick: stop,
  onMouseDown: stop,
  onPointerDown: stop,
  onKeyDown: stop,
  onDoubleClick: stop,
  onContextMenu: stop,
};

/** Text fields where native keys (Backspace, arrows, Mod-Z) must stay native. */
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

/**
 * Groups of the active view in the group column's option order (ungrouped last),
 * or null when the view is not grouped. The ungrouped group only shows while it
 * has rows; hidden groups and, if set, empty groups are left out.
 */
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

/** Cell values that put a new row into `group`. */
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

/** "Mine" is a table over the viewer's rows, so it takes the table's settings. */
export function isTableView(view: Pick<DatabaseView, "type">) {
  return view.type === "table" || view.type === "mine";
}

/** The "mine" view's rows: those whose member columns include `userId`. */
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
