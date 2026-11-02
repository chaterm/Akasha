import { useState, type PointerEvent } from "react";
import { Text, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";
import {
  DATABASE_MIN_COLUMN_WIDTH,
  type DatabaseColumn,
  type DatabaseColumnType,
} from "@docmost/editor-ext";
import {
  columnAlign,
  patchView,
  type DatabaseContext,
} from "./database-context";
import { ColumnMenu } from "./database-column-menu";
import { COLUMN_TYPE_LABELS } from "./database-ui";
import classes from "./database.module.css";

/** Width of the leading row-number column. */
export const ROW_NUMBER_WIDTH = 56;

const DEFAULT_WIDTHS: Record<DatabaseColumnType, number> = {
  text: 200,
  number: 120,
  select: 160,
  multiSelect: 200,
  person: 160,
  page: 200,
  date: 140,
  checkbox: 90,
  url: 200,
};

export function columnWidth(
  db: DatabaseContext,
  column: DatabaseColumn,
  live: Record<string, number>,
) {
  return (
    live[column.id] ??
    db.view.columns.find((entry) => entry.id === column.id)?.width ??
    DEFAULT_WIDTHS[column.type]
  );
}

interface HeaderProps {
  db: DatabaseContext;
  columns: DatabaseColumn[];
  /** Widths while a resize is in progress, keyed by column id. */
  liveWidths: Record<string, number>;
  setLiveWidths: (widths: Record<string, number>) => void;
  menuColumnId: string | null;
  setMenuColumnId: (id: string | null) => void;
  /** Header cell selected by keyboard navigation. */
  selectedColumnId: string | null;
  draggingColumnId: string | null;
  onColumnPointerDown: (
    event: PointerEvent<HTMLElement>,
    column: DatabaseColumn,
  ) => void;
}

export function DatabaseTableHeader({
  db,
  columns,
  liveWidths,
  setLiveWidths,
  menuColumnId,
  setMenuColumnId,
  selectedColumnId,
  draggingColumnId,
  onColumnPointerDown,
}: HeaderProps) {
  const { t } = useTranslation();
  const [resizing, setResizing] = useState<string | null>(null);

  const startResize = (
    event: PointerEvent<HTMLDivElement>,
    column: DatabaseColumn,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = columnWidth(db, column, liveWidths);
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    setResizing(column.id);
    let width = startWidth;
    const onMove = (move: globalThis.PointerEvent) => {
      width = Math.max(
        DATABASE_MIN_COLUMN_WIDTH,
        Math.round(startWidth + move.clientX - startX),
      );
      setLiveWidths({ [column.id]: width });
    };
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      setResizing(null);
      setLiveWidths({});
      // One write per drag keeps undo history and Yjs updates small.
      if (width !== startWidth) {
        patchView(db, {
          columns: db.view.columns.map((entry) =>
            entry.id === column.id ? { ...entry, width } : entry,
          ),
        });
      }
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  };

  return (
    <thead>
      <tr>
        <th className={classes.gutterCell} />
        {db.view.showRowNumbers && (
          <th
            className={classes.rowNumberCell}
            style={{ width: ROW_NUMBER_WIDTH }}
          >
            <span className={classes.rowNumberHeader}>{t("No.")}</span>
          </th>
        )}
        {columns.map((column) => {
          const draggable = db.editable;
          const label = (
            <UnstyledButton
              className={classes.headerButton}
              data-align={columnAlign(db, column)}
              disabled={!db.editable}
              data-draggable={draggable || undefined}
              title={
                draggable
                  ? t("Drag to reorder, double-click to edit")
                  : undefined
              }
              onPointerDown={
                draggable
                  ? (event) => onColumnPointerDown(event, column)
                  : undefined
              }
              onDoubleClick={() =>
                setMenuColumnId(menuColumnId === column.id ? null : column.id)
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") setMenuColumnId(column.id);
              }}
              onContextMenu={(event) => {
                if (!db.editable) return;
                event.preventDefault();
                setMenuColumnId(column.id);
              }}
            >
              <Text size="sm" fw={500} truncate>
                {column.name || t(COLUMN_TYPE_LABELS[column.type])}
              </Text>
            </UnstyledButton>
          );
          return (
            <th
              key={column.id}
              data-column-id={column.id}
              data-selected={selectedColumnId === column.id || undefined}
              data-dragging={draggingColumnId === column.id || undefined}
              style={{ width: columnWidth(db, column, liveWidths) }}
            >
              {db.editable ? (
                <ColumnMenu
                  db={db}
                  column={column}
                  opened={menuColumnId === column.id}
                  onClose={() => setMenuColumnId(null)}
                  onInserted={setMenuColumnId}
                  alignable
                >
                  {label}
                </ColumnMenu>
              ) : (
                label
              )}
              {db.editable && (
                <div
                  className={classes.resizeHandle}
                  data-active={resizing === column.id || undefined}
                  onPointerDown={(event) => startResize(event, column)}
                />
              )}
            </th>
          );
        })}
      </tr>
    </thead>
  );
}
