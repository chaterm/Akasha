import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { UnstyledButton } from "@mantine/core";
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
import classes from "./database.module.css";

export interface CellPosition {
  rowId: string;
  columnId: string;
}

const GUTTER_WIDTH = 52;
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
  // Rows in display order (expanded groups only); a multi-select row in several groups counts once.
  const rows = useMemo(() => {
    if (!grouping) return ordered;
    const seen = new Set<string>();
    return grouping.groups
      .filter((group) => !collapsed.has(group.key))
      .flatMap((group) => group.rows)
      .filter((row) => !seen.has(row.id) && !!seen.add(row.id));
  }, [grouping, ordered, collapsed]);

  // Drop a selection whose row or column no longer exists (deleted, possibly remotely).
  useEffect(() => {
    if (!selection) return;
    if (
      (selection.rowId !== HEADER_ROW &&
        !rows.some((row) => row.id === selection.rowId)) ||
      !columns.some((c) => c.id === selection.columnId)
    ) {
      setSelection(null);
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
    setSelection(position);
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
      setSelection({
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
    setSelection({
      rowId: r < 0 ? HEADER_ROW : rows[r].id,
      columnId: columns[c].id,
    });
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
  ) => {
    const id = createRow(db, { ...side, values });
    if (!id) return;
    const afterId = side.beforeRowId
      ? (rows[rows.findIndex((row) => row.id === side.beforeRowId) - 1]?.id ??
        null)
      : side.afterRowId;
    freeze({ id, afterId });
    if (!columns.length) return;
    setSelection({ rowId: id, columnId: columns[0].id });
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
    switch (event.key) {
      case "ArrowUp":
        handled();
        return move(-1, 0);
      case "ArrowDown":
        handled();
        return move(1, 0);
      case "ArrowLeft":
        handled();
        return move(0, -1);
      case "ArrowRight":
        handled();
        return move(0, 1);
      case "Tab":
        if (!selection) return;
        handled();
        return move(0, event.shiftKey ? -1 : 1, true);
      case "Escape":
        if (!selection) return;
        handled();
        return setSelection(null);
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
      db.apply((tr, pos) =>
        setDatabaseCellValue(
          tr,
          pos,
          selection.rowId,
          selection.columnId,
          null,
        ),
      );
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

  const columnDropIndex = (x: number, y: number) =>
    hitTestList(containerRef.current, "th[data-column-id]", "x", x, y);
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
      editing={selection?.rowId === row.id && editing ? editing : null}
      dragging={rowDrag.dragging === row.id}
      dropBefore={dropIndex === index}
      canDrag={db.editable}
      dragBlocked={dragBlocked}
      onCellMouseDown={(columnId) => {
        focusGrid();
        setSelection({ rowId: row.id, columnId });
        const column = columns.find((item) => item.id === columnId);
        if (column?.type === "checkbox") startEdit({ rowId: row.id, columnId });
      }}
      onCellDoubleClick={(columnId) => startEdit({ rowId: row.id, columnId })}
      onEditDone={finishEdit}
      onInsert={(side) =>
        addRow(
          side === "above" ? { beforeRowId: row.id } : { afterRowId: row.id },
        )
      }
      onGripPointerDown={(event) =>
        rowDrag.onPointerDown(event, row.id, event.currentTarget.closest("tr"))
      }
    />
  );

  const addColumn = () => {
    let id = "";
    db.apply((tr, pos) => {
      id = addDatabaseColumn(tr, pos, { name: t("Text"), type: "text" });
    });
    if (id) setTimeout(() => setMenuColumnId(id), 0);
  };

  return (
    <div
      ref={containerRef}
      className={classes.tableScroll}
      tabIndex={0}
      data-db-focus
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (
          !editing &&
          !event.currentTarget.contains(event.relatedTarget as Node)
        )
          setSelection(null);
      }}
    >
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
                            addRow({}, groupValues(grouping.column, group))
                          }
                        />,
                        ...(open
                          ? group.rows.map((row) =>
                              renderRow(
                                row,
                                ++number,
                                `${group.key}:${row.id}`,
                                -1,
                              ),
                            )
                          : []),
                      ];
                    });
                  })()
                : rows.map((row, index) =>
                    renderRow(row, index + 1, row.id, index),
                  )}
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
  );
}
