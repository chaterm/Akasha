import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { UnstyledButton } from "@mantine/core";
import type { CSSProperties } from "react";
import { IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  addDatabaseColumn,
  moveDatabaseRow,
  setDatabaseCellValue,
  type DatabaseCellValue,
  type DatabaseRowData,
} from "@docmost/editor-ext";
import {
  createRow,
  groupValues,
  patchView,
  useViewGroups,
  useViewRows,
  visibleColumns,
  type DatabaseContext,
} from "./database-context";
import { toggleCheckbox, type EditDoneReason } from "./database-cells";
import {
  DatabaseTableHeader,
  ROW_NUMBER_WIDTH,
  columnWidth,
} from "./database-table-header";
import { DatabaseTableRow } from "./database-table-row";
import { DatabaseTableGroupRow } from "./database-table-group";
import { elementAt, hitTestList, usePointerDrag } from "./use-pointer-drag";
import { useStickyHeader } from "./use-sticky-header";
import { planRowMoves } from "./database-utils";
import { pasteIntoTable, rangeToTSV } from "./database-clipboard";
import { DatabaseBulkBar, DatabaseRangeBar } from "./database-bulk-bar";
import classes from "./database.module.css";

export interface CellPosition {
  rowId: string;
  columnId: string;
}

/** Grip, row menu and checkbox, outside the table frame. */
const GUTTER_WIDTH = 72;
/** Rows shown at first and added by each "Load more". */
const PAGE_SIZE = 50;
/** `rowId` of a selection on the header row. */
const HEADER_ROW = "__header";
const ADD_COLUMN_WIDTH = 40;

/** Moves a column before another in the active view's column order; null = to the end. */
function moveColumnBefore(
  db: DatabaseContext,
  columnId: string,
  beforeId: string | null,
) {
  if (columnId === beforeId) return;
  const entries = [...db.view.columns];
  const from = entries.findIndex((entry) => entry.id === columnId);
  if (from < 0) return;
  const [entry] = entries.splice(from, 1);
  const to = beforeId
    ? entries.findIndex((item) => item.id === beforeId)
    : entries.length;
  if (to < 0 || to === from) return;
  entries.splice(to, 0, entry);
  patchView(db, { columns: entries });
}

export default function DatabaseTableView({ db }: { db: DatabaseContext }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const columns = visibleColumns(db);
  const viewRows = useViewRows(db);
  const [selection, setSelection] = useState<CellPosition | null>(null);
  const [editing, setEditing] = useState<{ initialText?: string } | null>(null);
  // While editing (or right after creating a row) the order is frozen so a
  // sort or filter on the edited column does not make the row jump away.
  const [frozen, setFrozen] = useState<string[] | null>(null);
  const [menuColumnId, setMenuColumnId] = useState<string | null>(null);
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  // Visible index the dragged row would be inserted at (for the indicator).
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // Visible column index the dragged column would be inserted before.
  const [columnDrop, setColumnDrop] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Far corner of a multi-cell range; `selection` is the other corner.
  const [rangeEnd, setRangeEnd] = useState<CellPosition | null>(null);
  /** Moves the selection to one cell (or none), dropping any range. */
  const select = (position: CellPosition | null) => {
    setSelection(position);
    setRangeEnd(null);
  };
  // Rows checked for a bulk action; shift-click extends from the last one.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const lastChecked = useRef<string | null>(null);
  // Rows shown before "Load more", per group key ("" when not grouped).
  const [limits, setLimits] = useState<Record<string, number>>({});
  const limitOf = (key: string) => limits[key] ?? PAGE_SIZE;
  const [scrolledX, setScrolledX] = useState(false);
  // Focused for Mod-C / X / V so the browser's own clipboard events can be used.
  const sinkRef = useRef<HTMLTextAreaElement>(null);
  useStickyHeader(tableRef);

  const ordered = useMemo(() => {
    if (!frozen) return viewRows;
    const byId = new Map(db.rows.map((row) => [row.id, row]));
    const kept = frozen
      .map((id) => byId.get(id))
      .filter(Boolean) as DatabaseRowData[];
    const keptIds = new Set(frozen);
    return [...kept, ...viewRows.filter((row) => !keptIds.has(row.id))];
  }, [frozen, viewRows, db.rows]);
  const grouping = useViewGroups(db, ordered);
  // Rows on screen in display order: expanded groups only, up to each "Load
  // more" limit; a multi-select row in several groups counts once.
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const shown = grouping
      ? grouping.groups
          .filter((group) => !collapsed.has(group.key))
          .flatMap((group) => group.rows.slice(0, limitOf(group.key)))
      : ordered.slice(0, limitOf(""));
    return shown.filter((row) => !seen.has(row.id) && !!seen.add(row.id));
  }, [grouping, ordered, collapsed, limits]);
  // Pasting continues past the loaded rows (ungrouped) instead of creating new ones.
  const pasteRows = grouping ? rows : ordered;

  // Checked rows that left the view (filtered out or deleted) are unchecked.
  useEffect(() => {
    if (!checked.size) return;
    const ids = new Set(viewRows.map((row) => row.id));
    if ([...checked].some((id) => !ids.has(id)))
      setChecked(new Set([...checked].filter((id) => ids.has(id))));
  }, [viewRows, checked]);

  // Drop a selection whose row or column no longer exists (deleted, possibly remotely).
  useEffect(() => {
    if (!selection) return;
    if (
      (selection.rowId !== HEADER_ROW &&
        !rows.some((row) => row.id === selection.rowId)) ||
      !columns.some((c) => c.id === selection.columnId)
    ) {
      select(null);
      setEditing(null);
    }
  }, [rows, columns, selection]);

  const focusGrid = () => containerRef.current?.focus({ preventScroll: true });
  /** `afterId`: undefined = append, null = first. */
  const freeze = (extra?: {
    id: string;
    afterId: string | null | undefined;
  }) => {
    const ids = rows.map((row) => row.id);
    if (extra) {
      const at =
        extra.afterId === undefined
          ? ids.length
          : extra.afterId === null
            ? 0
            : ids.indexOf(extra.afterId) + 1;
      ids.splice(at, 0, extra.id);
    }
    setFrozen(ids);
  };

  const startEdit = (position: CellPosition, initialText?: string) => {
    if (position.rowId === HEADER_ROW) {
      setMenuColumnId(position.columnId);
      return;
    }
    const column = columns.find((item) => item.id === position.columnId);
    const row = rows.find((item) => item.id === position.rowId);
    if (!db.editable || !column || !row) return;
    select(position);
    if (column.type === "checkbox") {
      toggleCheckbox(db, row, column);
      return;
    }
    if (!frozen) freeze();
    setEditing({ initialText });
  };

  /** Moves the selection; row index -1 is the header row. */
  const move = (rowDelta: number, columnDelta: number, wrap = false) => {
    if (!columns.length) return;
    if (!selection) {
      select({
        rowId: rows[0]?.id ?? HEADER_ROW,
        columnId: columns[0].id,
      });
      return;
    }
    let r =
      selection.rowId === HEADER_ROW
        ? -1
        : rows.findIndex((row) => row.id === selection.rowId);
    let c =
      columns.findIndex((column) => column.id === selection.columnId) +
      columnDelta;
    if (wrap && c >= columns.length) [r, c] = [r + 1, 0];
    if (wrap && c < 0) [r, c] = [r - 1, columns.length - 1];
    r = Math.min(Math.max(r + rowDelta, -1), rows.length - 1);
    c = Math.min(Math.max(c, 0), columns.length - 1);
    select({
      rowId: r < 0 ? HEADER_ROW : rows[r].id,
      columnId: columns[c].id,
    });
  };

  /** Index bounds of the selected range (a single cell without one), or null on the header row. */
  const selectedRange = () => {
    if (!selection || selection.rowId === HEADER_ROW) return null;
    const end = rangeEnd ?? selection;
    const index = (position: CellPosition) => ({
      r: pasteRows.findIndex((row) => row.id === position.rowId),
      c: columns.findIndex((column) => column.id === position.columnId),
    });
    const a = index(selection);
    const b = index(end);
    if (a.r < 0 || a.c < 0 || b.r < 0 || b.c < 0) return null;
    return {
      top: Math.min(a.r, b.r),
      bottom: Math.max(a.r, b.r),
      left: Math.min(a.c, b.c),
      right: Math.max(a.c, b.c),
    };
  };
  const range = selectedRange();
  const rangeRows = range ? pasteRows.slice(range.top, range.bottom + 1) : [];
  const rangeColumns = range ? columns.slice(range.left, range.right + 1) : [];
  const multiCell = rangeRows.length * rangeColumns.length > 1;
  const rangeRowIds = new Set(multiCell ? rangeRows.map((row) => row.id) : []);
  const rangeColumnIds = new Set(rangeColumns.map((column) => column.id));

  /** Shift + arrow / click: moves the range's far corner. */
  const extend = (rowDelta: number, columnDelta: number) => {
    if (!selection || selection.rowId === HEADER_ROW) return;
    const end = rangeEnd ?? selection;
    const r = Math.min(
      Math.max(
        pasteRows.findIndex((row) => row.id === end.rowId) + rowDelta,
        0,
      ),
      pasteRows.length - 1,
    );
    const c = Math.min(
      Math.max(
        columns.findIndex((column) => column.id === end.columnId) + columnDelta,
        0,
      ),
      columns.length - 1,
    );
    if (r < 0 || c < 0) return;
    setRangeEnd({ rowId: pasteRows[r].id, columnId: columns[c].id });
  };

  const clearRange = () =>
    db.apply((tr, pos) => {
      for (const row of rangeRows)
        for (const column of rangeColumns)
          setDatabaseCellValue(tr, pos, row.id, column.id, null);
    });

  /** Lets the browser copy / paste through a focused hidden textarea, then returns focus. */
  const clipboard = (kind: "copy" | "cut" | "paste") => {
    const sink = sinkRef.current;
    if (!sink || !range) return false;
    sink.value =
      kind === "paste" ? "" : rangeToTSV(db, rangeRows, rangeColumns);
    sink.focus({ preventScroll: true });
    sink.select();
    setTimeout(() => {
      if (kind === "cut") clearRange();
      if (document.activeElement === sink) focusGrid();
    }, 0);
    return true;
  };

  const paste = (text: string) => {
    if (!range || !db.editable) return;
    const result = pasteIntoTable(db, text, pasteRows, columns, {
      top: range.top,
      left: range.left,
      height: range.bottom - range.top + 1,
      width: range.right - range.left + 1,
    });
    if (!result?.rowIds.length) return;
    const shown = range.top + result.rowIds.length;
    if (!grouping && shown > limitOf(""))
      setLimits((current) => ({ ...current, "": shown }));
    setSelection({ rowId: result.rowIds[0], columnId: result.columnIds[0] });
    setRangeEnd(
      result.rowIds.length * result.columnIds.length > 1
        ? {
            rowId: result.rowIds[result.rowIds.length - 1],
            columnId: result.columnIds[result.columnIds.length - 1],
          }
        : null,
    );
  };

  const finishEdit = (reason: EditDoneReason) => {
    setEditing(null);
    setFrozen(null);
    if (reason === "enter") move(1, 0);
    if (reason === "tab") move(0, 1, true);
    if (reason === "shiftTab") move(0, -1, true);
    if (reason !== "blur") focusGrid();
  };

  /** Creates a row next to another (or at the end) and starts editing its first cell. */
  const addRow = (
    side: { afterRowId?: string; beforeRowId?: string } = {},
    values?: Record<string, DatabaseCellValue>,
    /** Group the row lands in, so its "Load more" limit makes room for it. */
    groupKey = "",
  ) => {
    const id = createRow(db, { ...side, values });
    if (!id) return;
    setLimits((current) => ({
      ...current,
      [groupKey]: (current[groupKey] ?? PAGE_SIZE) + 1,
    }));
    const afterId = side.beforeRowId
      ? (rows[rows.findIndex((row) => row.id === side.beforeRowId) - 1]?.id ??
        null)
      : side.afterRowId;
    freeze({ id, afterId });
    if (!columns.length) return;
    select({ rowId: id, columnId: columns[0].id });
    setEditing({});
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      editing ||
      event.target !== event.currentTarget ||
      event.nativeEvent.isComposing
    )
      return;
    const mod = event.metaKey || event.ctrlKey;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (arrows[event.key]) {
      handled();
      const [rowDelta, columnDelta] = arrows[event.key];
      if (event.shiftKey && selection) return extend(rowDelta, columnDelta);
      return move(rowDelta, columnDelta);
    }
    const key = event.key.toLowerCase();
    if (mod && !event.altKey && ["c", "x", "v"].includes(key)) {
      // Copy works read-only; the native event follows on the focused sink.
      if (key !== "c" && !db.editable) return;
      if (clipboard(key === "c" ? "copy" : key === "x" ? "cut" : "paste"))
        event.stopPropagation();
      return;
    }
    if (mod && key === "a" && pasteRows.length && columns.length) {
      handled();
      setSelection({ rowId: pasteRows[0].id, columnId: columns[0].id });
      setRangeEnd({
        rowId: pasteRows[pasteRows.length - 1].id,
        columnId: columns[columns.length - 1].id,
      });
      return;
    }
    switch (event.key) {
      case "Tab":
        if (!selection) return;
        handled();
        return move(0, event.shiftKey ? -1 : 1, true);
      case "Escape":
        if (selection) {
          handled();
          return select(null);
        }
        if (checked.size) {
          handled();
          setChecked(new Set());
        }
        return;
    }
    if (!selection || !db.editable) return;
    if (selection.rowId === HEADER_ROW) {
      if (event.key === "Enter") {
        handled();
        startEdit(selection);
      }
      return;
    }
    if (event.key === "Enter") {
      handled();
      if (event.shiftKey) addRow({ afterRowId: selection.rowId });
      else startEdit(selection);
    } else if (event.key === "Backspace" || event.key === "Delete") {
      handled();
      clearRange();
    } else if (event.key.length === 1 && !mod && !event.altKey) {
      const column = columns.find((item) => item.id === selection.columnId);
      // Typing starts editing text-like cells with the typed character; progress takes digits.
      if (
        column &&
        (["text", "number", "url"].includes(column.type) ||
          (column.type === "progress" && /\d/.test(event.key)))
      ) {
        handled();
        startEdit(selection, event.key);
      } else if (event.key === " ") {
        handled();
        startEdit(selection);
      }
    }
  };

  const dragBlocked = grouping
    ? t("Remove grouping to reorder rows")
    : db.view.sorts.length
      ? t("Remove sorting to reorder rows")
      : null;
  const canDragRows = db.editable && !dragBlocked;
  const rowDrag = usePointerDrag<string>({
    onMove: (_, x, y) => setDropIndex(visibleDropIndex(x, y)),
    onDrop: (rowId, x, y) => {
      setDropIndex(null);
      const index = visibleDropIndex(x, y);
      if (index === null) return;
      const before = beforeRowIdAt(index);
      db.apply((tr, pos) => moveDatabaseRow(tr, pos, rowId, before));
    },
    onCancel: () => setDropIndex(null),
    scrollContainer: () => containerRef.current,
    cursor: "grabbing",
  });

  // Nothing can be dropped before the title column.
  const columnDropIndex = (x: number, y: number) =>
    Math.max(
      hitTestList(containerRef.current, "th[data-column-id]", "x", x, y),
      1,
    );
  const columnDrag = usePointerDrag<string>({
    onMove: (_, x, y) => setColumnDrop(columnDropIndex(x, y)),
    onDrop: (columnId, x, y) => {
      setColumnDrop(null);
      moveColumnBefore(
        db,
        columnId,
        columns[columnDropIndex(x, y)]?.id ?? null,
      );
    },
    onCancel: () => setColumnDrop(null),
    scrollContainer: () => containerRef.current,
    cursor: "grabbing",
  });

  /** Left offset of the column drop line inside the scroll container. */
  function columnDropLeft(index: number): number {
    return (
      GUTTER_WIDTH +
      rowNumberWidth +
      columns
        .slice(0, index)
        .reduce((sum, column) => sum + columnWidth(db, column, liveWidths), 0)
    );
  }

  function visibleDropIndex(x: number, y: number): number | null {
    const element = elementAt(x, y, "tr[data-row-id]");
    if (!element || !containerRef.current?.contains(element)) return null;
    const rect = element.getBoundingClientRect();
    const index = rows.findIndex((row) => row.id === element.dataset.rowId);
    return index < 0 ? null : index + (y > rect.top + rect.height / 2 ? 1 : 0);
  }

  /** The visible slot mapped to document order: insert before this row id, null = at the end. */
  function beforeRowIdAt(index: number): string | null {
    if (index < rows.length) return rows[index].id;
    // After the last visible row: before the next row in document order, if any.
    const docIndex = db.rows.findIndex(
      (row) => row.id === rows[rows.length - 1]?.id,
    );
    return db.rows[docIndex + 1]?.id ?? null;
  }

  const rowNumberWidth = db.view.showRowNumbers ? ROW_NUMBER_WIDTH : 0;
  // Everything inside the table frame: row numbers plus the data columns.
  const dataWidth =
    rowNumberWidth +
    columns.reduce(
      (sum, column) => sum + columnWidth(db, column, liveWidths),
      0,
    );
  const tableWidth = GUTTER_WIDTH + dataWidth;

  const toggleGroup = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** `index` is the row's slot for drop indicators; -1 in grouped tables, where rows cannot be dragged. */
  const renderRow = (
    row: DatabaseRowData,
    number: number,
    key: string,
    index: number,
  ) => (
    <DatabaseTableRow
      key={key}
      db={db}
      row={row}
      rowNumber={db.view.showRowNumbers ? number : null}
      columns={columns}
      selection={selection?.rowId === row.id ? selection.columnId : null}
      rangeColumns={rangeRowIds.has(row.id) ? rangeColumnIds : null}
      wrapColumns={wrapColumns}
      checked={checked.has(row.id)}
      checking={checked.size > 0}
      onCheck={(shiftKey) => toggleCheck(row.id, shiftKey)}
      editing={selection?.rowId === row.id && editing ? editing : null}
      dragging={rowDrag.dragging === row.id}
      dropBefore={dropIndex === index}
      canDrag={db.editable}
      dragBlocked={dragBlocked}
      onCellMouseDown={(columnId, shiftKey) => {
        focusGrid();
        if (shiftKey && selection && selection.rowId !== HEADER_ROW) {
          setRangeEnd({ rowId: row.id, columnId });
          return;
        }
        select({ rowId: row.id, columnId });
        const column = columns.find((item) => item.id === columnId);
        if (column?.type === "checkbox") startEdit({ rowId: row.id, columnId });
        else startRangeDrag({ rowId: row.id, columnId });
      }}
      onCellDoubleClick={(columnId) => startEdit({ rowId: row.id, columnId })}
      onEditDone={finishEdit}
      onGripPointerDown={(event) =>
        rowDrag.onPointerDown(event, row.id, event.currentTarget.closest("tr"))
      }
    />
  );

  /** Dragging from a cell selects the cells it passes over. */
  const startRangeDrag = (anchor: CellPosition) => {
    const onMove = (event: globalThis.MouseEvent) => {
      const cell = elementAt(
        event.clientX,
        event.clientY,
        "td[data-column-id]",
      );
      const rowId =
        cell?.closest<HTMLElement>("tr[data-row-id]")?.dataset.rowId;
      const columnId = cell?.dataset.columnId;
      if (!rowId || !columnId || !containerRef.current?.contains(cell)) return;
      setRangeEnd(
        rowId === anchor.rowId && columnId === anchor.columnId
          ? null
          : { rowId, columnId },
      );
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** Shift-click checks every row between the last checked one and this one. */
  const toggleCheck = (rowId: string, shiftKey: boolean) => {
    const next = new Set(checked);
    const anchor = lastChecked.current;
    const from = anchor ? rows.findIndex((row) => row.id === anchor) : -1;
    const to = rows.findIndex((row) => row.id === rowId);
    if (shiftKey && from >= 0 && to >= 0) {
      const on = !checked.has(rowId);
      for (const row of rows.slice(Math.min(from, to), Math.max(from, to) + 1))
        if (on) next.add(row.id);
        else next.delete(row.id);
    } else if (next.has(rowId)) next.delete(rowId);
    else next.add(rowId);
    lastChecked.current = rowId;
    setChecked(next);
  };
  const checkState: "none" | "some" | "all" = !checked.size
    ? "none"
    : viewRows.every((row) => checked.has(row.id))
      ? "all"
      : "some";
  const checkedRows = viewRows.filter((row) => checked.has(row.id));
  const planMoves = (direction: "up" | "down") =>
    planRowMoves(
      db.rows.map((row) => row.id),
      viewRows.map((row) => row.id),
      checked,
      direction,
    );

  const wrapColumns = new Set(
    db.view.columns.filter((entry) => entry.wrap).map((entry) => entry.id),
  );

  /** "Load more" under the rows of a group ("" when not grouped). */
  const loadMore = (key: string, total: number) => {
    const limit = limitOf(key);
    if (total <= limit) return null;
    return (
      <tr key={`more:${key}`} className={classes.loadMoreRow}>
        <td className={classes.gutterCell} />
        <td colSpan={columns.length + (db.view.showRowNumbers ? 1 : 0)}>
          <UnstyledButton
            className={classes.loadMore}
            onClick={() =>
              setLimits((current) => ({ ...current, [key]: limit + PAGE_SIZE }))
            }
          >
            {t("Load more ({{count}} remaining)", { count: total - limit })}
          </UnstyledButton>
        </td>
      </tr>
    );
  };

  const addColumn = () => {
    let id = "";
    db.apply((tr, pos) => {
      id = addDatabaseColumn(tr, pos, { name: t("Text"), type: "text" });
    });
    if (id) setTimeout(() => setMenuColumnId(id), 0);
  };

  const titleLeft =
    GUTTER_WIDTH + (db.view.showRowNumbers ? ROW_NUMBER_WIDTH : 0);

  return (
    <div className={classes.tableView}>
      {checkedRows.length > 0 ? (
        <DatabaseBulkBar
          db={db}
          rows={checkedRows}
          onClear={() => setChecked(new Set())}
          moveBlocked={dragBlocked}
          canMoveUp={planMoves("up").length > 0}
          canMoveDown={planMoves("down").length > 0}
          onMove={(direction) => {
            const moves = planMoves(direction);
            db.apply((tr, pos) => {
              for (const move of moves)
                moveDatabaseRow(tr, pos, move.rowId, move.beforeRowId);
            });
          }}
          onInsert={(side) =>
            addRow(
              side === "above"
                ? { beforeRowId: checkedRows[0].id }
                : { afterRowId: checkedRows[checkedRows.length - 1].id },
            )
          }
        />
      ) : (
        multiCell &&
        db.editable &&
        !editing && (
          <DatabaseRangeBar
            count={rangeRows.length * rangeColumns.length}
            onClearValues={() => {
              clearRange();
              focusGrid();
            }}
            onCancel={() => {
              select(null);
              focusGrid();
            }}
          />
        )
      )}
      <div
        ref={containerRef}
        className={classes.tableScroll}
        tabIndex={0}
        data-db-focus
        data-row-height={db.view.rowHeight}
        data-scrolled-x={scrolledX || undefined}
        style={
          {
            "--db-gutter": `${GUTTER_WIDTH}px`,
            "--db-title-left": `${titleLeft}px`,
          } as CSSProperties
        }
        onScroll={(event) => {
          const next = event.currentTarget.scrollLeft > 0;
          if (next !== scrolledX) setScrolledX(next);
        }}
        onKeyDown={onKeyDown}
        onBlur={(event) => {
          if (
            !editing &&
            !event.currentTarget.contains(event.relatedTarget as Node)
          )
            select(null);
        }}
      >
        <textarea
          ref={sinkRef}
          className={classes.clipboardSink}
          tabIndex={-1}
          aria-hidden
          readOnly={!db.editable}
          onPaste={(event) => {
            event.preventDefault();
            event.stopPropagation();
            paste(event.clipboardData.getData("text/plain"));
            focusGrid();
          }}
        />
        <div
          className={classes.tableBlock}
          data-align={db.view.align}
          style={{ width: tableWidth + (db.editable ? ADD_COLUMN_WIDTH : 0) }}
        >
          <div className={classes.tableFrame}>
            <table
              ref={tableRef}
              className={classes.table}
              style={{ width: tableWidth }}
            >
              <DatabaseTableHeader
                db={db}
                columns={columns}
                liveWidths={liveWidths}
                setLiveWidths={setLiveWidths}
                menuColumnId={menuColumnId}
                setMenuColumnId={(id) => {
                  setMenuColumnId(id);
                  if (!id) focusGrid();
                }}
                selectedColumnId={
                  selection?.rowId === HEADER_ROW ? selection.columnId : null
                }
                draggingColumnId={columnDrag.dragging}
                checkState={checkState}
                onCheckAll={() =>
                  setChecked(
                    checkState === "all"
                      ? new Set()
                      : new Set(viewRows.map((row) => row.id)),
                  )
                }
                onColumnPointerDown={(event, column) =>
                  columnDrag.onPointerDown(
                    event,
                    column.id,
                    event.currentTarget.closest("th"),
                  )
                }
              />
              <tbody>
                {grouping
                  ? (() => {
                      let number = 0;
                      return grouping.groups.flatMap((group) => {
                        const open = !collapsed.has(group.key);
                        return [
                          <DatabaseTableGroupRow
                            key={`group:${group.key}`}
                            db={db}
                            column={grouping.column}
                            group={group}
                            span={
                              columns.length + (db.view.showRowNumbers ? 1 : 0)
                            }
                            collapsed={!open}
                            onToggle={() => toggleGroup(group.key)}
                            onAdd={() =>
                              addRow(
                                {},
                                groupValues(grouping.column, group),
                                group.key,
                              )
                            }
                          />,
                          ...(open
                            ? group.rows
                                .slice(0, limitOf(group.key))
                                .map((row) =>
                                  renderRow(
                                    row,
                                    ++number,
                                    `${group.key}:${row.id}`,
                                    -1,
                                  ),
                                )
                            : []),
                          open && loadMore(group.key, group.rows.length),
                        ];
                      });
                    })()
                  : [
                      ...rows.map((row, index) =>
                        renderRow(row, index + 1, row.id, index),
                      ),
                      loadMore("", ordered.length),
                    ]}
              </tbody>
            </table>
            {db.editable && (
              <UnstyledButton
                className={classes.addColumnStrip}
                style={{ width: ADD_COLUMN_WIDTH }}
                aria-label={t("Add column")}
                title={t("Add column")}
                onClick={addColumn}
              >
                <IconPlus size={14} />
              </UnstyledButton>
            )}
          </div>
          {dropIndex !== null && dropIndex >= rows.length && (
            <div className={classes.rowDropEnd} style={{ width: dataWidth }} />
          )}
          {columnDrop !== null && (
            <div
              className={classes.columnDrop}
              style={{
                left: columnDropLeft(columnDrop),
                height: tableRef.current?.offsetHeight,
              }}
            />
          )}
          {db.editable && (
            <UnstyledButton
              className={classes.newRowStrip}
              style={{ width: dataWidth }}
              aria-label={t("New row")}
              title={t("New row")}
              onClick={() => addRow()}
            >
              <IconPlus size={14} />
            </UnstyledButton>
          )}
        </div>
      </div>
    </div>
  );
}
