import type { PointerEvent } from "react";
import { ActionIcon, Checkbox } from "@mantine/core";
import { IconArrowsDiagonal, IconGripVertical } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { DatabaseColumn, DatabaseRowData } from "@docmost/editor-ext";
import {
  columnAlign,
  isTextTarget,
  type DatabaseContext,
} from "./database-context";
import { CellDisplay, CellEditor, type EditDoneReason } from "./database-cells";
import { RowMenu } from "./database-row-menu";
import classes from "./database.module.css";

interface TableRowProps {
  db: DatabaseContext;
  row: DatabaseRowData;
  /** 1-based position in the view; null hides the row-number cell. */
  rowNumber: number | null;
  columns: DatabaseColumn[];
  /** Selected column id in this row. */
  selection: string | null;
  editing: { initialText?: string } | null;
  dragging: boolean;
  dropBefore: boolean;
  canDrag: boolean;
  /** Why rows cannot be dragged right now (sorted or grouped view); null = they can. */
  dragBlocked: string | null;
  onCellMouseDown: (columnId: string) => void;
  onCellDoubleClick: (columnId: string) => void;
  onEditDone: (reason: EditDoneReason) => void;
  onInsert: (side: "above" | "below") => void;
  onGripPointerDown: (event: PointerEvent<HTMLElement>) => void;
}

export function DatabaseTableRow({
  db,
  row,
  rowNumber,
  columns,
  selection,
  editing,
  dragging,
  dropBefore,
  canDrag,
  dragBlocked,
  onCellMouseDown,
  onCellDoubleClick,
  onEditDone,
  onInsert,
  onGripPointerDown,
}: TableRowProps) {
  const { t } = useTranslation();

  return (
    <tr
      data-row-id={row.id}
      className={classes.row}
      data-dragging={dragging || undefined}
      data-drop-before={dropBefore || undefined}
    >
      <td className={classes.gutterCell}>
        <div className={classes.gutter}>
          {canDrag && (
            <span
              className={`${classes.grip} ${classes.hoverAction}`}
              data-disabled={dragBlocked || undefined}
              title={dragBlocked ?? t("Drag to reorder")}
              onPointerDown={dragBlocked ? undefined : onGripPointerDown}
            >
              <IconGripVertical size={14} />
            </span>
          )}
          <RowMenu
            db={db}
            rowId={row.id}
            onInsert={onInsert}
            showExpand={rowNumber === null}
          />
        </div>
      </td>
      {rowNumber !== null && (
        <td className={classes.rowNumberCell}>
          <span className={classes.rowNumber}>{rowNumber}</span>
          <ActionIcon
            size="xs"
            variant="default"
            className={`${classes.openButton} ${classes.hoverAction}`}
            aria-label={t("Expand")}
            title={t("Expand")}
            onClick={() => db.openRow(row.id)}
          >
            <IconArrowsDiagonal size={12} />
          </ActionIcon>
        </td>
      )}
      {columns.map((column) => {
        const selected = selection === column.id;
        const isEditing = selected && !!editing;
        const display = CellDisplay({ db, column, row });
        const content =
          column.type === "checkbox" ? (
            <Checkbox
              size="xs"
              readOnly
              tabIndex={-1}
              checked={row.values[column.id] === true}
            />
          ) : (
            display
          );
        return (
          <td
            key={column.id}
            className={classes.cell}
            data-selected={selected || undefined}
            data-editing={isEditing || undefined}
            data-type={column.type}
            data-align={columnAlign(db, column)}
            onMouseDown={(event) => {
              if (isEditing || event.button !== 0 || isTextTarget(event.target))
                return;
              if ((event.target as HTMLElement).closest("a,button")) return;
              event.preventDefault();
              onCellMouseDown(column.id);
            }}
            onDoubleClick={(event) => {
              if (isEditing || column.type === "checkbox") return;
              if ((event.target as HTMLElement).closest("a,button")) return;
              onCellDoubleClick(column.id);
            }}
          >
            {isEditing ? (
              <CellEditor
                db={db}
                row={row}
                column={column}
                initialText={editing.initialText}
                anchor={<div className={classes.cellContent}>{content}</div>}
                onDone={onEditDone}
              />
            ) : (
              <div className={classes.cellContent}>{content}</div>
            )}
          </td>
        );
      })}
    </tr>
  );
}
