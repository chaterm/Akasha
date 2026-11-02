import type { PointerEvent, ReactNode } from "react";
import { ActionIcon, Group } from "@mantine/core";
import { IconArrowsDiagonal } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  isDatabaseValueEmpty,
  readDatabaseValue,
  type DatabaseColumn,
  type DatabaseRowData,
} from "@docmost/editor-ext";
import {
  isTextTarget,
  ownsEvent,
  visibleColumns,
  type DatabaseContext,
} from "./database-context";
import { FieldValue } from "./database-cells";
import { RowMenu } from "./database-row-menu";
import { COLUMN_TYPE_ICONS, COLUMN_TYPE_LABELS } from "./database-ui";
import classes from "./database.module.css";

interface KanbanCardProps {
  db: DatabaseContext;
  row: DatabaseRowData;
  /** The group column is implied by the lane, so it is not repeated on the card. */
  groupColumnId?: string;
  dragging: boolean;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  onInsert: (side: "above" | "below") => void;
  menuExtra?: (close: () => void) => ReactNode;
}

/** Fields edit in place; clicking blank card space opens the row. */
export function KanbanCard({
  db,
  row,
  groupColumnId,
  dragging,
  onPointerDown,
  onInsert,
  menuExtra,
}: KanbanCardProps) {
  const { t } = useTranslation();
  // The first visible field (other than the group) leads the card, shown like the rest.
  const [title, ...rest] = visibleColumns(db).filter(
    (column) => column.id !== groupColumnId,
  );
  const fields = rest.filter(
    (column: DatabaseColumn) =>
      !isDatabaseValueEmpty(column.type, readDatabaseValue(column, row)),
  );

  return (
    <div
      className={classes.card}
      data-card-id={row.id}
      data-dragging={dragging || undefined}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        // Fields drag too: they only edit on double-click.
        if (
          !ownsEvent(event) ||
          isTextTarget(target) ||
          target.closest("button,a,[data-editing]")
        )
          return;
        onPointerDown?.(event);
      }}
      onClick={(event) => {
        if (
          !ownsEvent(event) ||
          (event.target as HTMLElement).closest("button,a,[data-field]")
        )
          return;
        db.openRow(row.id);
      }}
    >
      <Group gap={2} wrap="nowrap" className={classes.cardActions}>
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
        <RowMenu
          db={db}
          rowId={row.id}
          onInsert={onInsert}
          extra={menuExtra}
          showExpand={false}
          insertLabels={{ above: t("Insert before"), below: t("Insert after") }}
        />
      </Group>
      {/* One grid for all rows: icon + name in the first column, values line up. */}
      <div className={classes.cardFields}>
        {title && (
          <div data-field className={classes.cardHeading}>
            <FieldValue
              db={db}
              row={row}
              column={title}
              placeholder={t("Untitled")}
              editOnDoubleClick
            />
          </div>
        )}
        {fields.map((column) => {
          const TypeIcon = COLUMN_TYPE_ICONS[column.type];
          const name = column.name || t(COLUMN_TYPE_LABELS[column.type]);
          return (
            <div key={column.id} className={classes.cardField}>
              <span className={classes.cardLabel} title={name}>
                <TypeIcon size={13} className={classes.cardIcon} />
                <span className={classes.ellipsis}>{name}</span>
              </span>
              <div data-field className={classes.cardFieldValue}>
                <FieldValue
                  db={db}
                  row={row}
                  column={column}
                  editOnDoubleClick
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
