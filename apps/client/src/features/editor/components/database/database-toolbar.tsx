import { useRef, useState } from "react";
import {
  ActionIcon,
  Button,
  CloseButton,
  Group,
  Popover,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconArrowsSort,
  IconFilter,
  IconLayoutRows,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  countDatabaseFilterConditions,
  DATABASE_GROUPABLE_TYPES,
  isDatabaseSortable,
  type DatabaseFilterGroup,
  type DatabaseSort,
} from "@docmost/editor-ext";
import {
  isTableView,
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
  const draft = db.filterDraft;
  const change = (filter: DatabaseFilterGroup) =>
    draft ? draft.change(filter) : patchView(db, { filter });
  const empty = count === 0 && !db.view.filter.conditions.length;
  const actions = draft && (
    <>
      <Button
        size="compact-xs"
        variant="subtle"
        color="gray"
        disabled={!db.view.filter.conditions.length}
        onClick={() => change({ ...db.view.filter, conditions: [] })}
      >
        {t("Clear filters")}
      </Button>
      <Button size="compact-xs" variant="default" onClick={draft.saveAsView}>
        {t("Add as new view")}
      </Button>
      <Button size="compact-xs" disabled={!draft.dirty} onClick={draft.save}>
        {t("Save")}
      </Button>
    </>
  );
  const showEmptyActions = empty && !!draft?.dirty;
  return (
    <Popover position="bottom-end" width={600} shadow="md" withinPortal>
      <Popover.Target>
        <Button
          size="compact-xs"
          variant={count ? "light" : "subtle"}
          color={count ? "blue" : "gray"}
          leftSection={<IconFilter size={14} />}
          rightSection={
            draft?.dirty ? (
              <span
                className={classes.unsavedDot}
                title={t("Unsaved changes")}
              />
            ) : undefined
          }
        >
          {count ? t("{{count}} filters", { count }) : t("Filter")}
        </Button>
      </Popover.Target>
      <Popover.Dropdown {...stopBubbling} p="xs">
        {empty ? (
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
                  change({
                    ...db.view.filter,
                    conditions: [newCondition(column)],
                  })
                }
              />
            ))}
          </Stack>
        ) : (
          <FilterGroupEditor
            db={db}
            group={db.view.filter}
            onChange={change}
            actions={actions}
          />
        )}
        {showEmptyActions && (
          <Group gap={6} wrap="nowrap" justify="flex-end" mt={6}>
            {actions}
          </Group>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}

function GroupButton({ db }: { db: DatabaseContext }) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const { view } = db;
  const groupable = db.columns.filter((column) =>
    DATABASE_GROUPABLE_TYPES.includes(column.type),
  );
  const current = db.columns.find((column) => column.id === view.groupBy);
  const pick = (groupBy: string | null) => {
    setOpened(false);
    if (groupBy === view.groupBy) return;
    patchView(db, { groupBy });
  };

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      width={240}
      shadow="md"
      withinPortal
    >
      <Popover.Target>
        <Button
          size="compact-xs"
          variant={current ? "light" : "subtle"}
          color={current ? "blue" : "gray"}
          leftSection={<IconLayoutRows size={14} />}
          onClick={() => setOpened((value) => !value)}
        >
          {current
            ? t("Group: {{name}}", { name: current.name || t("Untitled") })
            : t("Grouping")}
        </Button>
      </Popover.Target>
      <Popover.Dropdown {...stopBubbling} p={4}>
        <Stack gap={0} className={classes.menu}>
          <Text size="xs" c="dimmed" px={8} py={4}>
            {t("Group by")}
          </Text>
          {view.type !== "kanban" && (
            <MenuRow
              label={t("None")}
              active={!current}
              onClick={() => pick(null)}
            />
          )}
          {groupable.map((column) => (
            <MenuRow
              key={column.id}
              icon={COLUMN_TYPE_ICONS[column.type]}
              label={column.name || t("Untitled")}
              active={column.id === view.groupBy}
              onClick={() => pick(column.id)}
            />
          ))}
          {groupable.length === 0 && (
            <Text size="xs" c="dimmed" px={8} py={4}>
              {t("Add a select or member property to group by it.")}
            </Text>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function SortButton({ db }: { db: DatabaseContext }) {
  const { t } = useTranslation();
  const { sorts } = db.view;
  const used = new Set(sorts.map((sort) => sort.columnId));
  const sortable = db.columns.filter((column) =>
    isDatabaseSortable(column.type),
  );
  const available = sortable.filter((column) => !used.has(column.id));
  const columnData = sortable.map((column) => ({
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
            <Group gap={6} wrap="nowrap" className={classes.sortRow}>
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
              <SegmentedControl
                size="xs"
                w={110}
                aria-label={t("Sort direction")}
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
        {sortable.length === 0 && (
          <Text size="xs" c="dimmed" p={4}>
            {t("No fields can be sorted")}
          </Text>
        )}
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
          {(isTableView(db.view) || db.view.type === "kanban") && (
            <GroupButton db={db} />
          )}
          <ViewOptions db={db} />
        </>
      )}
    </Group>
  );
}
