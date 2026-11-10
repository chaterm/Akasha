import { Button, CloseButton, Group, Text, Tooltip } from "@mantine/core";
import {
  IconArrowDown,
  IconArrowUp,
  IconEraser,
  IconRowInsertBottom,
  IconRowInsertTop,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  deleteDatabaseRow,
  setDatabaseCellValue,
  type DatabaseRowData,
} from "@docmost/editor-ext";
import type { DatabaseContext } from "./database-context";
import classes from "./database.module.css";

export function DatabaseRangeBar({
  count,
  onClearValues,
  onCancel,
}: {
  count: number;
  onClearValues: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Group
      gap={4}
      wrap="nowrap"
      className={classes.bulkBar}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <Text size="sm" fw={500} px={6}>
        {t("{{count}} cells selected", { count })}
      </Text>
      <Button
        size="compact-xs"
        variant="subtle"
        color="gray"
        leftSection={<IconEraser size={14} />}
        onClick={onClearValues}
      >
        {t("Clear values")}
      </Button>
      <Button
        size="compact-xs"
        variant="subtle"
        color="gray"
        onClick={onCancel}
      >
        {t("Cancel")}
      </Button>
    </Group>
  );
}

function MoveButton({
  icon: Icon,
  label,
  blocked,
  disabled,
  onClick,
}: {
  icon: typeof IconArrowUp;
  label: string;
  blocked: string | null;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={blocked} disabled={!blocked} withinPortal>
      <span className={classes.bulkBarSlot}>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          leftSection={<Icon size={14} />}
          disabled={disabled || !!blocked}
          onClick={onClick}
        >
          {label}
        </Button>
      </span>
    </Tooltip>
  );
}

export function DatabaseBulkBar({
  db,
  rows,
  onClear,
  moveBlocked,
  canMoveUp,
  canMoveDown,
  onMove,
  onInsert,
}: {
  db: DatabaseContext;
  rows: DatabaseRowData[];
  onClear: () => void;
  moveBlocked: string | null;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: "up" | "down") => void;
  onInsert: (side: "above" | "below") => void;
}) {
  const { t } = useTranslation();

  const clearValues = () =>
    db.apply((tr, pos) => {
      for (const row of rows)
        for (const column of db.columns)
          setDatabaseCellValue(tr, pos, row.id, column.id, null);
    });

  return (
    <Group
      gap={4}
      wrap="nowrap"
      className={classes.bulkBar}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <Text size="sm" fw={500} px={6}>
        {t("{{count}} selected", { count: rows.length })}
      </Text>
      {db.editable && (
        <>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            leftSection={<IconRowInsertTop size={14} />}
            onClick={() => onInsert("above")}
          >
            {t("Insert above")}
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            leftSection={<IconRowInsertBottom size={14} />}
            onClick={() => onInsert("below")}
          >
            {t("Insert below")}
          </Button>
          <MoveButton
            icon={IconArrowUp}
            label={t("Move up")}
            blocked={moveBlocked}
            disabled={!canMoveUp}
            onClick={() => onMove("up")}
          />
          <MoveButton
            icon={IconArrowDown}
            label={t("Move down")}
            blocked={moveBlocked}
            disabled={!canMoveDown}
            onClick={() => onMove("down")}
          />
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            leftSection={<IconEraser size={14} />}
            onClick={clearValues}
          >
            {t("Clear values")}
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            leftSection={<IconTrash size={14} />}
            onClick={() => {
              db.apply((tr, pos) => {
                for (const row of rows) deleteDatabaseRow(tr, pos, row.id);
              });
              onClear();
            }}
          >
            {t("Delete rows")}
          </Button>
        </>
      )}
      <CloseButton
        size="sm"
        aria-label={t("Clear selection")}
        onClick={onClear}
      />
    </Group>
  );
}
