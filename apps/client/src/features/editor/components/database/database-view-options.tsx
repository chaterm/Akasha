import { useEffect, useState } from "react";
import {
  ActionIcon,
  Button,
  Group,
  Popover,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  UnstyledButton,
} from "@mantine/core";
import {
  IconAdjustmentsHorizontal,
  IconCheck,
  IconChevronRight,
  IconEye,
  IconEyeOff,
  IconListNumbers,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  deleteDatabaseView,
  DATABASE_GROUPABLE_TYPES,
} from "@docmost/editor-ext";
import {
  columnAlign,
  isTableView,
  stopBubbling,
  patchView,
  visibleColumns,
  type DatabaseContext,
} from "./database-context";
import {
  AlignPicker,
  COLUMN_TYPE_ICONS,
  MenuBack,
  MenuDivider,
  MenuRow,
} from "./database-ui";
import { SortableList } from "./sortable-list";
import { moveItem } from "./database-utils";
import classes from "./database.module.css";

const NO_PORTAL = { withinPortal: false };

function PropertiesPage({
  db,
  onBack,
}: {
  db: DatabaseContext;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const byId = new Map(db.columns.map((column) => [column.id, column]));
  const entries = db.view.columns;
  const setHidden = (ids: Set<string>) =>
    patchView(db, {
      columns: entries.map((entry) => ({
        ...entry,
        hidden: ids.has(entry.id),
      })),
    });
  const hidden = new Set(
    entries.filter((entry) => entry.hidden).map((entry) => entry.id),
  );

  return (
    <Stack gap={4}>
      <MenuBack label={t("Properties")} onBack={onBack} />
      <Group gap={4} justify="flex-end">
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          onClick={() => setHidden(new Set())}
        >
          {t("Show all")}
        </Button>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          onClick={() => setHidden(new Set(entries.map((entry) => entry.id)))}
        >
          {t("Hide all")}
        </Button>
      </Group>
      {isTableView(db.view) && (
        <Group gap={8} px={8} py={4} wrap="nowrap">
          <IconListNumbers size={15} className={classes.menuIcon} />
          <Text
            size="sm"
            flex={1}
            truncate
            c={db.view.showRowNumbers ? undefined : "dimmed"}
          >
            {t("No.")}
          </Text>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label={db.view.showRowNumbers ? t("Hide") : t("Show")}
            onClick={() =>
              patchView(db, { showRowNumbers: !db.view.showRowNumbers })
            }
          >
            {db.view.showRowNumbers ? (
              <IconEye size={14} />
            ) : (
              <IconEyeOff size={14} />
            )}
          </ActionIcon>
        </Group>
      )}
      <SortableList
        items={entries}
        getKey={(entry) => entry.id}
        onMove={(from, to) =>
          patchView(db, { columns: moveItem(entries, from, to) })
        }
        renderItem={(entry) => {
          const column = byId.get(entry.id)!;
          const TypeIcon = COLUMN_TYPE_ICONS[column.type];
          return (
            <Group gap={8} wrap="nowrap" pr={4}>
              <TypeIcon size={15} className={classes.menuIcon} />
              <Text
                size="sm"
                flex={1}
                truncate
                c={entry.hidden ? "dimmed" : undefined}
              >
                {column.name || t("Untitled")}
              </Text>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                aria-label={entry.hidden ? t("Show") : t("Hide")}
                onClick={() => {
                  const next = new Set(hidden);
                  if (entry.hidden) next.delete(entry.id);
                  else next.add(entry.id);
                  setHidden(next);
                }}
              >
                {entry.hidden ? (
                  <IconEyeOff size={14} />
                ) : (
                  <IconEye size={14} />
                )}
              </ActionIcon>
            </Group>
          );
        }}
      />
    </Stack>
  );
}

export function ViewOptions({ db }: { db: DatabaseContext }) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const [page, setPage] = useState<"main" | "properties">("main");
  const { view, columns } = db;
  useEffect(() => {
    if (!opened) setPage("main");
  }, [opened]);

  const ofTypes = (types: readonly string[]) =>
    columns
      .filter((column) => types.includes(column.type))
      .map((column) => ({
        value: column.id,
        label: column.name || t("Untitled"),
      }));
  const shownCount = view.columns.filter((entry) => !entry.hidden).length;
  // Alignment every visible column has, or null when they differ.
  const aligns = new Set(
    visibleColumns(db).map((column) => columnAlign(db, column)),
  );
  const sharedAlign = aligns.size === 1 ? [...aligns][0] : null;
  const groupable = ofTypes(DATABASE_GROUPABLE_TYPES);
  const iconOf = (id: string | null) => {
    const column = columns.find((item) => item.id === id);
    return column ? COLUMN_TYPE_ICONS[column.type] : null;
  };
  const GroupByIcon = iconOf(view.groupBy);

  const main = (
    <Stack gap={8}>
      <UnstyledButton
        className={classes.optionRow}
        onClick={() => setPage("properties")}
      >
        <Text size="xs" fw={500}>
          {t("Properties")}
        </Text>
        <Group gap={4} wrap="nowrap">
          <Text size="xs" c="dimmed">
            {t("{{count}} shown", { count: shownCount })}
          </Text>
          <IconChevronRight size={14} className={classes.menuIcon} />
        </Group>
      </UnstyledButton>
      {view.type === "kanban" && (
        <Group justify="space-between" wrap="nowrap">
          <Text size="xs" fw={500}>
            {t("Direction")}
          </Text>
          <SegmentedControl
            size="xs"
            value={view.orientation}
            onChange={(orientation) =>
              patchView(db, {
                orientation: orientation as "vertical" | "horizontal",
              })
            }
            data={[
              { value: "vertical", label: t("Vertical") },
              { value: "horizontal", label: t("Horizontal") },
            ]}
          />
        </Group>
      )}
      {(isTableView(view) ||
        (view.type === "kanban" && view.orientation === "vertical")) && (
        <Group justify="space-between" wrap="nowrap">
          <Text size="xs" fw={500}>
            {t("View alignment")}
          </Text>
          <AlignPicker
            value={view.align}
            onChange={(align) => patchView(db, { align })}
          />
        </Group>
      )}
      {isTableView(view) && (
        <Group justify="space-between" wrap="nowrap">
          <Text size="xs" fw={500}>
            {t("Cell alignment")}
          </Text>
          <AlignPicker
            value={sharedAlign}
            onChange={(align) =>
              patchView(db, {
                columns: view.columns.map((entry) => ({ ...entry, align })),
              })
            }
          />
        </Group>
      )}
      {(isTableView(view) || view.type === "kanban") && (
        <>
          {/* A board always needs a group column; a table can be ungrouped. */}
          <Select
            size="xs"
            label={t("Group by")}
            description={
              groupable.length
                ? undefined
                : t("Add a select or member property to group by it.")
            }
            allowDeselect={false}
            clearable={view.type !== "kanban"}
            placeholder={t("None")}
            data={groupable}
            leftSection={GroupByIcon && <GroupByIcon size={14} />}
            renderOption={({ option, checked }) => {
              const OptionIcon = iconOf(option.value);
              return (
                <Group gap={8} wrap="nowrap" flex={1}>
                  {OptionIcon && (
                    <OptionIcon size={14} className={classes.menuIcon} />
                  )}
                  <Text size="xs" flex={1} truncate>
                    {option.label}
                  </Text>
                  {checked && <IconCheck size={12} />}
                </Group>
              );
            }}
            value={view.groupBy}
            onChange={(groupBy) =>
              (groupBy || view.type !== "kanban") && patchView(db, { groupBy })
            }
            comboboxProps={NO_PORTAL}
          />
          {view.groupBy && (
            <Switch
              size="xs"
              label={t("Hide empty groups")}
              checked={view.hideEmptyGroups}
              onChange={(event) =>
                patchView(db, { hideEmptyGroups: event.currentTarget.checked })
              }
            />
          )}
        </>
      )}
      {(view.type === "calendar" || view.type === "timeline") && (
        <>
          <Select
            size="xs"
            label={t("Start date")}
            allowDeselect={false}
            data={ofTypes(["date"])}
            value={view.dateColumnId}
            onChange={(dateColumnId) =>
              dateColumnId && patchView(db, { dateColumnId })
            }
            comboboxProps={NO_PORTAL}
          />
          <Select
            size="xs"
            label={t("End date")}
            clearable
            placeholder={t("None")}
            data={ofTypes(["date"]).filter(
              (item) => item.value !== view.dateColumnId,
            )}
            value={view.endDateColumnId}
            onChange={(endDateColumnId) => patchView(db, { endDateColumnId })}
            comboboxProps={NO_PORTAL}
          />
        </>
      )}
      {db.views.length > 1 && (
        <>
          <MenuDivider />
          <div className={classes.menu}>
            <MenuRow
              icon={IconTrash}
              label={t("Delete view")}
              danger
              onClick={() => {
                setOpened(false);
                db.apply((tr, pos) => deleteDatabaseView(tr, pos, view.id));
              }}
            />
          </div>
        </>
      )}
    </Stack>
  );

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      width={300}
      shadow="md"
      withinPortal
    >
      <Popover.Target>
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          aria-label={t("View settings")}
          onClick={() => setOpened((value) => !value)}
        >
          <IconAdjustmentsHorizontal size={15} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown {...stopBubbling} p="xs">
        {page === "properties" ? (
          <PropertiesPage db={db} onBack={() => setPage("main")} />
        ) : (
          main
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
