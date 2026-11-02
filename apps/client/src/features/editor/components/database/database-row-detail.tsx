import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ActionIcon,
  Button,
  Drawer,
  Group,
  Menu,
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
import {
  addDatabaseColumn,
  deleteDatabaseRow,
  type DatabaseColumn,
  type DatabaseRowData,
} from "@docmost/editor-ext";
import { stopBubbling, type DatabaseContext } from "./database-context";
import { FieldValue, writeCell } from "./database-cells";
import { ColumnMenu } from "./database-column-menu";
import {
  ADDABLE_COLUMN_TYPES,
  COLUMN_TYPE_ICONS,
  COLUMN_TYPE_LABELS,
} from "./database-ui";
import classes from "./database.module.css";

interface RowDetailProps {
  db: DatabaseContext;
  /** The database node's id; presses inside it keep the drawer open. */
  databaseId: string;
  rowId: string | null;
  /** Row ids in the active view's order, for previous / next. */
  order: string[];
  onNavigate: (rowId: string) => void;
  onClose: () => void;
}

/** The row's title as a large heading input; saves on blur and Enter. */
function TitleField({
  db,
  row,
  column,
}: {
  db: DatabaseContext;
  row: DatabaseRowData;
  column: DatabaseColumn;
}) {
  const { t } = useTranslation();
  const value = String(row.values[column.id] ?? "");
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value, row.id]);
  // Escape blurs without saving.
  const cancelled = useRef(false);
  return (
    <textarea
      className={classes.detailTitle}
      rows={1}
      value={draft}
      readOnly={!db.editable}
      placeholder={t("Untitled")}
      aria-label={column.name || t("Title")}
      ref={(element) => {
        if (!element) return;
        element.style.height = "auto";
        element.style.height = `${element.scrollHeight}px`;
      }}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        if (!cancelled.current && draft !== value)
          writeCell(db, row.id, column.id, draft);
        cancelled.current = false;
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.stopPropagation();
          cancelled.current = true;
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * Side peek of one row: the title, then every property, including ones hidden
 * in the view. It has no overlay, so the view stays usable and clicking
 * another row switches to it.
 */
export function DatabaseRowDetail({
  db,
  databaseId,
  rowId,
  order,
  onNavigate,
  onClose,
}: RowDetailProps) {
  const { t } = useTranslation();
  const row = rowId ? db.rows.find((item) => item.id === rowId) : null;
  const contentRef = useRef<HTMLDivElement>(null);
  const [menuColumnId, setMenuColumnId] = useState<string | null>(null);
  // Nested editors close on Escape themselves; the drawer must not close with them.
  const editors = useRef(0);
  const [nested, setNested] = useState(false);
  const trackEditing = (editing: boolean) => {
    editors.current = Math.max(0, editors.current + (editing ? 1 : -1));
    setNested(editors.current > 0);
  };

  useEffect(() => {
    if (rowId && !row) onClose();
  }, [rowId, row, onClose]);

  // No overlay: a press outside the drawer, its popovers and this database closes it.
  const open = !!row;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.closest?.(
          `[data-portal], [data-database-id="${CSS.escape(databaseId)}"]`,
        )
      )
        return;
      // Closing unmounts the fields before the browser's normal focus change.
      // Blur first so their pending drafts are committed while still mounted.
      const active = document.activeElement;
      if (active instanceof HTMLElement && contentRef.current?.contains(active))
        active.blur();
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, databaseId, onClose]);

  // Mantine listens for Escape on the window; this only closes on Escape pressed inside the drawer.
  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape" && !nested && !menuColumnId) onClose();
  };

  const index = row ? order.indexOf(row.id) : -1;
  const [title, ...properties] = db.view.columns
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
    <Drawer
      opened={!!row}
      onClose={onClose}
      position="right"
      size={520}
      withOverlay={false}
      lockScroll={false}
      trapFocus={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
      shadow="xl"
      classNames={{ content: classes.detailDrawer }}
      title={
        <Group gap={4} onKeyDown={onKeyDown}>
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
        // The drawer is a portal child of the node view; its events must not reach the view's handlers.
        <div ref={contentRef} {...stopBubbling} onKeyDown={onKeyDown}>
          <Stack gap="sm">
            {title && <TitleField db={db} row={row} column={title} />}
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
    </Drawer>
  );
}
