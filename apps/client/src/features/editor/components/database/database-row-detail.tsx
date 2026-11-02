import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Button,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconChevronDown,
  IconChevronUp,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { addDatabaseColumn, deleteDatabaseRow } from "@docmost/editor-ext";
import { stopBubbling, type DatabaseContext } from "./database-context";
import { FieldValue } from "./database-cells";
import { ColumnMenu } from "./database-column-menu";
import {
  ADDABLE_COLUMN_TYPES,
  COLUMN_TYPE_ICONS,
  COLUMN_TYPE_LABELS,
} from "./database-ui";
import classes from "./database.module.css";

interface RowDetailProps {
  db: DatabaseContext;
  rowId: string | null;
  /** Row ids in the active view's order, for previous / next. */
  order: string[];
  onNavigate: (rowId: string) => void;
  onClose: () => void;
}

/** Centered peek of one row: every property, including ones hidden in the view. */
export function DatabaseRowDetail({
  db,
  rowId,
  order,
  onNavigate,
  onClose,
}: RowDetailProps) {
  const { t } = useTranslation();
  const row = rowId ? db.rows.find((item) => item.id === rowId) : null;
  const [menuColumnId, setMenuColumnId] = useState<string | null>(null);
  // Nested editors close on Escape themselves; the modal must not close with them.
  const editors = useRef(0);
  const [nested, setNested] = useState(false);
  const trackEditing = (editing: boolean) => {
    editors.current = Math.max(0, editors.current + (editing ? 1 : -1));
    setNested(editors.current > 0);
  };

  useEffect(() => {
    if (rowId && !row) onClose();
  }, [rowId, row, onClose]);

  const index = row ? order.indexOf(row.id) : -1;
  const properties = db.view.columns
    .map((entry) => db.columns.find((column) => column.id === entry.id)!)
    .filter(Boolean);

  const addProperty = (type: (typeof ADDABLE_COLUMN_TYPES)[number]) => {
    let id = "";
    db.apply((tr, pos) => {
      id = addDatabaseColumn(tr, pos, {
        name: t(COLUMN_TYPE_LABELS[type]),
        type,
      });
    });
    if (id) setTimeout(() => setMenuColumnId(id), 0);
  };

  return (
    <Modal
      opened={!!row}
      onClose={onClose}
      size="xl"
      centered
      closeOnEscape={!nested && !menuColumnId}
      title={
        <Group gap={4}>
          <Tooltip label={t("Previous")} withinPortal>
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              disabled={index <= 0}
              aria-label={t("Previous")}
              onClick={() => onNavigate(order[index - 1])}
            >
              <IconChevronUp size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("Next")} withinPortal>
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              disabled={index < 0 || index >= order.length - 1}
              aria-label={t("Next")}
              onClick={() => onNavigate(order[index + 1])}
            >
              <IconChevronDown size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      }
    >
      {row && (
        // The modal is a portal child of the node view; its events must not reach the view's handlers.
        <div {...stopBubbling}>
          <Stack gap="sm">
            <Stack gap={2}>
              {properties.map((column) => {
                const TypeIcon = COLUMN_TYPE_ICONS[column.type];
                const label = (
                  <UnstyledButton
                    className={classes.detailLabel}
                    disabled={!db.editable}
                    onClick={() => setMenuColumnId(column.id)}
                  >
                    <TypeIcon size={15} className={classes.menuIcon} />
                    <Text size="sm" c="dimmed" truncate>
                      {column.name || t(COLUMN_TYPE_LABELS[column.type])}
                    </Text>
                  </UnstyledButton>
                );
                return (
                  <Group
                    key={column.id}
                    gap="xs"
                    wrap="nowrap"
                    align="flex-start"
                    className={classes.detailRow}
                  >
                    {db.editable ? (
                      <ColumnMenu
                        db={db}
                        column={column}
                        opened={menuColumnId === column.id}
                        onClose={() => setMenuColumnId(null)}
                        onInserted={setMenuColumnId}
                      >
                        {label}
                      </ColumnMenu>
                    ) : (
                      label
                    )}
                    <div className={classes.detailValue}>
                      <FieldValue
                        db={db}
                        row={row}
                        column={column}
                        onEditingChange={trackEditing}
                      />
                    </div>
                  </Group>
                );
              })}
            </Stack>
            {db.editable && (
              <Group justify="space-between">
                <Menu shadow="md" position="bottom-start" withinPortal>
                  <Menu.Target>
                    <Button
                      size="xs"
                      variant="subtle"
                      color="gray"
                      leftSection={<IconPlus size={14} />}
                    >
                      {t("Add property")}
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown {...stopBubbling}>
                    {ADDABLE_COLUMN_TYPES.map((type) => {
                      const TypeIcon = COLUMN_TYPE_ICONS[type];
                      return (
                        <Menu.Item
                          key={type}
                          leftSection={<TypeIcon size={14} />}
                          onClick={() => addProperty(type)}
                        >
                          {t(COLUMN_TYPE_LABELS[type])}
                        </Menu.Item>
                      );
                    })}
                  </Menu.Dropdown>
                </Menu>
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => {
                    onClose();
                    db.apply((tr, pos) => deleteDatabaseRow(tr, pos, row.id));
                  }}
                >
                  {t("Delete")}
                </Button>
              </Group>
            )}
          </Stack>
        </div>
      )}
    </Modal>
  );
}
