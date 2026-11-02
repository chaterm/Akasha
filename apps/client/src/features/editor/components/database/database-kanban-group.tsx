import { useState, type PointerEvent } from "react";
import { ActionIcon, Group, Popover, Text } from "@mantine/core";
import { IconDots, IconEyeOff, IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  isDatabaseReference,
  updateDatabaseColumn,
  DATABASE_CHECKED_GROUP,
  type DatabaseColumn,
  type DatabaseGroup,
} from "@docmost/editor-ext";
import {
  stopBubbling,
  patchView,
  type DatabaseContext,
} from "./database-context";
import { MenuRow, OptionLabel } from "./database-ui";
import { OptionSettings } from "./tag-select";
import classes from "./database.module.css";

export function groupLabel(
  column: DatabaseColumn,
  group: DatabaseGroup,
  t: (key: string, options?: any) => string,
) {
  if (column.type === "checkbox")
    return group.key === DATABASE_CHECKED_GROUP ? t("Checked") : t("Unchecked");
  return t("Ungrouped");
}

/** The group's option badge, or its label when it has no option. */
export function GroupName({
  column,
  group,
}: {
  column: DatabaseColumn;
  group: DatabaseGroup;
}) {
  const { t } = useTranslation();
  return group.option ? (
    <OptionLabel type={column.type} option={group.option} menu />
  ) : (
    <Text size="xs" fw={500} c="dimmed">
      {groupLabel(column, group, t)}
    </Text>
  );
}

interface GroupHeaderProps {
  db: DatabaseContext;
  column: DatabaseColumn;
  group: DatabaseGroup;
  onAddCard: () => void;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
}

/** Lane header: option badge (rename/recolor/delete), count, add card, hide group. */
export function KanbanGroupHeader({
  db,
  column,
  group,
  onAddCard,
  onPointerDown,
}: GroupHeaderProps) {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const option = group.option;
  const options = column.options ?? [];

  const label = <GroupName column={column} group={group} />;

  return (
    <Group
      gap={6}
      wrap="nowrap"
      className={classes.laneHeader}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        onPointerDown?.(event);
      }}
    >
      {/* Members and documents are not edited from the board, only select options are. */}
      {option && db.editable && !isDatabaseReference(column.type) ? (
        <Popover
          opened={settingsOpen}
          onChange={setSettingsOpen}
          position="bottom-start"
          width={240}
          shadow="md"
          withinPortal
        >
          <Popover.Target>
            <span
              className={classes.laneLabel}
              title={t("Double-click to edit")}
              onDoubleClick={() => setSettingsOpen((value) => !value)}
            >
              {label}
            </span>
          </Popover.Target>
          <Popover.Dropdown {...stopBubbling} p="xs">
            <OptionSettings
              option={option}
              onChange={(patch) =>
                db.apply((tr, pos) =>
                  updateDatabaseColumn(tr, pos, column.id, {
                    options: options.map((item) =>
                      item.id === option.id ? { ...item, ...patch } : item,
                    ),
                  }),
                )
              }
              onDelete={() => {
                setSettingsOpen(false);
                db.apply((tr, pos) =>
                  updateDatabaseColumn(tr, pos, column.id, {
                    options: options.filter((item) => item.id !== option.id),
                  }),
                );
              }}
            />
          </Popover.Dropdown>
        </Popover>
      ) : (
        label
      )}
      <Text size="xs" c="dimmed">
        {group.rows.length}
      </Text>
      <span className={classes.flexSpacer} />
      {db.editable && (
        <>
          <Popover
            opened={menuOpen}
            onChange={setMenuOpen}
            position="bottom-end"
            width={200}
            shadow="md"
            withinPortal
          >
            <Popover.Target>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                className={classes.hoverAction}
                data-visible={menuOpen || undefined}
                aria-label={t("More")}
                onClick={() => setMenuOpen((value) => !value)}
              >
                <IconDots size={14} />
              </ActionIcon>
            </Popover.Target>
            <Popover.Dropdown {...stopBubbling} p={4} className={classes.menu}>
              <MenuRow
                icon={IconEyeOff}
                label={t("Hide group")}
                onClick={() => {
                  setMenuOpen(false);
                  patchView(db, {
                    hiddenGroups: [...db.view.hiddenGroups, group.key],
                  });
                }}
              />
            </Popover.Dropdown>
          </Popover>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label={t("New")}
            onClick={onAddCard}
          >
            <IconPlus size={14} />
          </ActionIcon>
        </>
      )}
    </Group>
  );
}
