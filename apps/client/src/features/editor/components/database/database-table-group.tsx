import { ActionIcon, Group, Text, UnstyledButton } from "@mantine/core";
import {
  IconChevronDown,
  IconChevronRight,
  IconPlus,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { DatabaseColumn, DatabaseGroup } from "@docmost/editor-ext";
import type { DatabaseContext } from "./database-context";
import { GroupName } from "./database-kanban-group";
import classes from "./database.module.css";

/** Header row of one group in a grouped table: collapse toggle, name, count, add. */
export function DatabaseTableGroupRow({
  db,
  column,
  group,
  span,
  collapsed,
  onToggle,
  onAdd,
}: {
  db: DatabaseContext;
  column: DatabaseColumn;
  group: DatabaseGroup;
  /** Cells the header spans inside the table frame. */
  span: number;
  collapsed: boolean;
  onToggle: () => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const Chevron = collapsed ? IconChevronRight : IconChevronDown;
  return (
    <tr className={classes.groupRow} data-group-key={group.key}>
      <td className={classes.gutterCell} />
      <td colSpan={span}>
        <Group gap={6} wrap="nowrap" className={classes.groupHeader}>
          <UnstyledButton
            className={classes.groupToggle}
            aria-label={collapsed ? t("Expand") : t("Collapse")}
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            <Chevron size={14} className={classes.menuIcon} />
            <GroupName column={column} group={group} />
          </UnstyledButton>
          <Text size="xs" c="dimmed">
            {group.rows.length}
          </Text>
          {db.editable && (
            <ActionIcon
              size="xs"
              variant="subtle"
              color="gray"
              className={classes.hoverAction}
              aria-label={t("New row")}
              title={t("New row")}
              onClick={onAdd}
            >
              <IconPlus size={12} />
            </ActionIcon>
          )}
        </Group>
      </td>
    </tr>
  );
}
