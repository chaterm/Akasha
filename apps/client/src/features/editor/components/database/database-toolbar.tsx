import { useRef, useState } from "react";
import {
  ActionIcon,
  Button,
  CloseButton,
  Group,
  Popover,
  Select,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconArrowsSort,
  IconFilter,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  countDatabaseFilterConditions,
  type DatabaseSort,
} from "@docmost/editor-ext";
import {
  stopBubbling,
  patchView,
  type DatabaseContext,
} from "./database-context";
import { FilterGroupEditor, newCondition } from "./database-filter";
import { SortableList } from "./sortable-list";
import { ViewOptions } from "./database-view-options";
import { moveItem } from "./database-utils";
import { MenuRow, COLUMN_TYPE_ICONS } from "./database-ui";
import classes from "./database.module.css";

const NO_PORTAL = { withinPortal: false };

function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(!!value);
  const inputRef = useRef<HTMLInputElement>(null);
  if (!open) {
    return (
      <Tooltip label={t("Search")} withinPortal>
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          aria-label={t("Search")}
          onClick={() => {
            setOpen(true);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
        >
          <IconSearch size={15} />
        </ActionIcon>
      </Tooltip>
    );
  }
  return (
    <div className={classes.searchBox}>
      <IconSearch size={14} className={classes.menuIcon} />
      <input
        ref={inputRef}
        autoFocus
        className={classes.searchInput}
        value={value}
        placeholder={t("Search")}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={() => !value && setOpen(false)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          if (value) onChange("");
          else setOpen(false);
        }}
      />
      {value && <CloseButton size="xs" onClick={() => onChange("")} />}
    </div>
  );
}

function FilterButton({ db }: { db: DatabaseContext }) {
  const { t } = useTranslation();
  const count = countDatabaseFilterConditions(db.view.filter);
  return (
    <Popover position="bottom-end" width={560} shadow="md" withinPortal>
      <Popover.Target>
        <Button
          size="compact-xs"
          variant={count ? "light" : "subtle"}
          color={count ? "blue" : "gray"}
          leftSection={<IconFilter size={14} />}
        >
          {count ? t("{{count}} filters", { count }) : t("Filter")}
        </Button>
      </Popover.Target>
      <Popover.Dropdown {...stopBubbling} p="xs">
        {count === 0 && !db.view.filter.conditions.length ? (
          <Stack gap={0} className={classes.menu}>
            <Text size="xs" c="dimmed" px={8} pb={4}>
              {t("Filter by")}
            </Text>
            {db.columns.map((column) => (
              <MenuRow
                key={column.id}
                icon={COLUMN_TYPE_ICONS[column.type]}
                label={column.name || t("Untitled")}
                onClick={() =>
                  patchView(db, {
                    filter: {
                      ...db.view.filter,
                      conditions: [newCondition(column)],
                    },
                  })
                }
              />
            ))}
          </Stack>
        ) : (
          <FilterGroupEditor
            db={db}
            group={db.view.filter}
            onChange={(filter) => patchView(db, { filter })}
          />
        )}
      </Popover.Dropdown>
    </Popover>
  );
}

function SortButton({ db }: { db: DatabaseContext }) {
  const { t } = useTranslation();
  const { sorts } = db.view;
  const used = new Set(sorts.map((sort) => sort.columnId));
  const available = db.columns.filter((column) => !used.has(column.id));
  const columnData = db.columns.map((column) => ({
    value: column.id,
    label: column.name || t("Untitled"),
  }));
  const write = (next: DatabaseSort[]) => patchView(db, { sorts: next });

  return (
    <Popover position="bottom-end" width={360} shadow="md" withinPortal>
      <Popover.Target>
        <Button
          size="compact-xs"
          variant={sorts.length ? "light" : "subtle"}
          color={sorts.length ? "blue" : "gray"}
          leftSection={<IconArrowsSort size={14} />}
        >
          {sorts.length
            ? t("{{count}} sorts", { count: sorts.length })
            : t("Sort")}
        </Button>
      </Popover.Target>
      <Popover.Dropdown {...stopBubbling} p="xs">
        <SortableList
          items={sorts}
          getKey={(sort) => sort.columnId}
          onMove={(from, to) => write(moveItem(sorts, from, to))}
          renderItem={(sort, index) => (
            <Group gap={6} wrap="nowrap">
              <Select
                size="xs"
                flex={1}
                allowDeselect={false}
                data={columnData.filter(
                  (item) =>
                    item.value === sort.columnId || !used.has(item.value),
                )}
                value={sort.columnId}
                onChange={(columnId) =>
                  columnId &&
                  write(
                    sorts.map((item, i) =>
                      i === index ? { ...item, columnId } : item,
                    ),
                  )
                }
                comboboxProps={NO_PORTAL}
              />
              <Select
                size="xs"
                w={110}
                allowDeselect={false}
                data={[
                  { value: "asc", label: t("Ascending") },
                  { value: "desc", label: t("Descending") },
                ]}
                value={sort.direction}
                onChange={(direction) =>
                  write(
                    sorts.map((item, i) =>
                      i === index
                        ? {
                            ...item,
                            direction: direction === "desc" ? "desc" : "asc",
                          }
                        : item,
                    ),
                  )
                }
                comboboxProps={NO_PORTAL}
              />
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                aria-label={t("Delete")}
                onClick={() => write(sorts.filter((_, i) => i !== index))}
              >
                <IconTrash size={14} />
              </ActionIcon>
            </Group>
          )}
        />
        {available.length > 0 && (
          // Insets match the sort rows: grip on the left, delete button on the right.
          <div
            className={classes.sortAdd}
            data-indented={sorts.length > 0 || undefined}
          >
            <Select
              size="xs"
              placeholder={t("Add sort; manual ordering turns off")}
              leftSection={<IconPlus size={12} />}
              data={available.map((column) => ({
                value: column.id,
                label: column.name || t("Untitled"),
              }))}
              value={null}
              onChange={(columnId) =>
                columnId && write([...sorts, { columnId, direction: "asc" }])
              }
              comboboxProps={NO_PORTAL}
            />
          </div>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}

/** Search, filter, sort and view options. Hidden controls in read-only mode. */
export function DatabaseToolbar({
  db,
  onSearch,
}: {
  db: DatabaseContext;
  onSearch: (value: string) => void;
}) {
  return (
    <Group gap={4} wrap="nowrap" className={classes.toolbar}>
      <SearchBox value={db.search} onChange={onSearch} />
      {db.editable && (
        <>
          <FilterButton db={db} />
          <SortButton db={db} />
          <ViewOptions db={db} />
        </>
      )}
    </Group>
  );
}
