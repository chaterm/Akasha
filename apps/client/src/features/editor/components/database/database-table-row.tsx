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
import classes from "./database.module.css";

interface TableRowProps {
  db: DatabaseContext;
  row: DatabaseRowData;
  /** 1-based position in the view; null hides the row-number cell. */
  rowNumber: number | null;
  columns: DatabaseColumn[];
  /** Selected column id in this row. */
  selection: string | null;
  /** Columns of a multi-cell range that covers this row. */
  rangeColumns: Set<string> | null;
  /** Columns that show their full value on several lines. */
  wrapColumns: Set<string>;
  /** Checked for a bulk action. */
  checked: boolean;
  /** Show the checkbox without hovering (some row is checked). */
  checking: boolean;
  onCheck: (shiftKey: boolean) => void;
  editing: { initialText?: string } | null;
  dragging: boolean;
  dropBefore: boolean;
  canDrag: boolean;
  /** Why rows cannot be dragged right now (sorted or grouped view); null = they can. */
  dragBlocked: string | null;
  onCellMouseDown: (columnId: string, shiftKey: boolean) => void;
  onCellDoubleClick: (columnId: string) => void;
  onEditDone: (reason: EditDoneReason) => void;
  onGripPointerDown: (event: PointerEvent<HTMLElement>) => void;
}

export function DatabaseTableRow({
  db,
  row,
  rowNumber,
  columns,
  selection,
  rangeColumns,
  wrapColumns,
  checked,
  checking,
  onCheck,
  editing,
  dragging,
  dropBefore,
  canDrag,
  dragBlocked,
  onCellMouseDown,
  onCellDoubleClick,
  onEditDone,
  onGripPointerDown,
}: TableRowProps) {
  const { t } = useTranslation();
  const titleId = db.columns[0]?.id;

  return (
    <tr
      data-row-id={row.id}
      className={classes.row}
      data-checked={checked || undefined}
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
          {rowNumber === null && (
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              className={classes.hoverAction}
              aria-label={t("Expand")}
              title={t("Expand")}
              onClick={() => db.openRow(row.id)}
            >
              <IconArrowsDiagonal size={14} />
            </ActionIcon>
          )}
          {db.editable && (
            <Checkbox
              size="xs"
              className={classes.rowCheck}
              wrapperProps={{
                "data-visible": checked || checking || undefined,
              }}
              aria-label={t("Select row")}
              checked={checked}
              onChange={(event) =>
                onCheck((event.nativeEvent as MouseEvent).shiftKey)
              }
            />
          )}
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
        const wrap = wrapColumns.has(column.id);
        const display = CellDisplay({ db, column, row, wrap });
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
            data-column-id={column.id}
            data-title-cell={column.id === titleId || undefined}
            data-wrap={wrap || undefined}
            data-in-range={rangeColumns?.has(column.id) || undefined}
            data-selected={selected || undefined}
            data-editing={isEditing || undefined}
            data-type={column.type}
            data-align={columnAlign(db, column)}
            onMouseDown={(event) => {
              if (isEditing || event.button !== 0 || isTextTarget(event.target))
                return;
              if ((event.target as HTMLElement).closest("a,button")) return;
              event.preventDefault();
              onCellMouseDown(column.id, event.shiftKey);
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
