import { useState, type ReactNode } from "react";
import { ActionIcon, Popover } from "@mantine/core";
import {
  IconArrowsDiagonal,
  IconDots,
  IconRowInsertBottom,
  IconRowInsertTop,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { deleteDatabaseRow } from "@docmost/editor-ext";
import type { DatabaseContext } from "./database-context";
import { stopBubbling } from "./database-context";
import { MenuDivider, MenuRow } from "./database-ui";
import classes from "./database.module.css";

interface RowMenuProps {
  db: DatabaseContext;
  rowId: string;
  onInsert: (side: "above" | "below") => void;
  /** Extra rows, e.g. kanban "Move to". */
  extra?: (close: () => void) => ReactNode;
  insertLabels?: { above: string; below: string };
  /** Off where the row already has its own expand button (row number cell, card). */
  showExpand?: boolean;
}

/** "…" menu of a row or card: open, insert above/below, delete. */
export function RowMenu({
  db,
  rowId,
  onInsert,
  extra,
  insertLabels,
  showExpand = true,
}: RowMenuProps) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const close = () => setOpened(false);

  if (!db.editable) {
    if (!showExpand) return null;
    return (
      <ActionIcon
        size="sm"
        variant="subtle"
        color="gray"
        className={classes.hoverAction}
        aria-label={t("Expand")}
        title={t("Expand")}
        onClick={(event) => {
          event.stopPropagation();
          db.openRow(rowId);
        }}
      >
        <IconArrowsDiagonal size={14} />
      </ActionIcon>
    );
  }

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-start"
      width={220}
      shadow="md"
      withinPortal
    >
      <Popover.Target>
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          className={classes.hoverAction}
          data-visible={opened || undefined}
          aria-label={t("More")}
          onClick={(event) => {
            event.stopPropagation();
            setOpened((value) => !value);
          }}
        >
          <IconDots size={14} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown {...stopBubbling} p={4} className={classes.menu}>
        {showExpand && (
          <MenuRow
            icon={IconArrowsDiagonal}
            label={t("Expand")}
            onClick={() => {
              close();
              db.openRow(rowId);
            }}
          />
        )}
        {extra?.(close)}
        <MenuRow
          icon={IconRowInsertTop}
          label={insertLabels?.above ?? t("Insert above")}
          onClick={() => {
            close();
            onInsert("above");
          }}
        />
        <MenuRow
          icon={IconRowInsertBottom}
          label={insertLabels?.below ?? t("Insert below")}
          onClick={() => {
            close();
            onInsert("below");
          }}
        />
        <MenuDivider />
        <MenuRow
          icon={IconTrash}
          label={t("Delete")}
          danger
          onClick={() => {
            close();
            db.apply((tr, pos) => deleteDatabaseRow(tr, pos, rowId));
          }}
        />

      </Popover.Dropdown>
    </Popover>
  );
}
