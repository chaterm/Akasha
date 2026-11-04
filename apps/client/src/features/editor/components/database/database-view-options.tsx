import { useEffect, useState, type ReactNode } from "react";
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
  IconChevronRight,
  IconEye,
  IconEyeOff,
  IconListNumbers,
  IconLock,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  deleteDatabaseView,
  type DatabaseCardSize,
  type DatabaseRowHeight,
} from "@docmost/editor-ext";
import {
  columnAlign,
  isDateView,
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
} from "./database-ui";
import { SortableList } from "./sortable-list";
import { moveItem } from "./database-utils";
import classes from "./database.module.css";

const NO_PORTAL = { withinPortal: false };

function OptionRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={classes.optionRow}>
      <Text className={classes.optionLabel}>{label}</Text>
      <Group
        gap={8}
        wrap="nowrap"
        justify="flex-end"
        className={classes.optionControl}
      >
        {children}
      </Group>
    </div>
  );
}

function PropertiesPage({
  db,
  onBack,
}: {
  db: DatabaseContext;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const byId = new Map(db.columns.map((column) => [column.id, column]));
  // The title leads every view and cannot be hidden or moved.
  const [titleEntry, ...entries] = db.view.columns;
  const title = byId.get(titleEntry.id)!;
  const TitleIcon = COLUMN_TYPE_ICONS[title.type];
  const setHidden = (ids: Set<string>) =>
    patchView(db, {
      columns: [
        titleEntry,
        ...entries.map((entry) => ({ ...entry, hidden: ids.has(entry.id) })),
      ],
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
        <Group gap={8} px={8} wrap="nowrap" className={classes.propertyRow}>
          <IconListNumbers size={15} className={classes.menuIcon} />
          <Text
            size="xs"
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
      <Group
        gap={8}
        px={8}
        wrap="nowrap"
        className={classes.propertyRow}
        title={t("Title")}
      >
        <TitleIcon size={15} className={classes.menuIcon} />
        <Text size="xs" flex={1} truncate>
          {title.name || t("Untitled")}
        </Text>
        <IconLock size={14} className={classes.menuIcon} />
      </Group>
      <SortableList
        items={entries}
        getKey={(entry) => entry.id}
        onMove={(from, to) =>
          patchView(db, {
            columns: [titleEntry, ...moveItem(entries, from, to)],
          })
        }
        renderItem={(entry) => {
          const column = byId.get(entry.id)!;
          const TypeIcon = COLUMN_TYPE_ICONS[column.type];
          return (
            <Group gap={8} wrap="nowrap" pr={4} className={classes.propertyRow}>
              <TypeIcon size={15} className={classes.menuIcon} />
              <Text
                size="xs"
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

  const main = (
    <Stack gap={4}>
      <UnstyledButton
        className={`${classes.optionRow} ${classes.optionLink}`}
        onClick={() => setPage("properties")}
      >
        <Text className={classes.optionLabel}>{t("Properties")}</Text>
        <Group gap={4} wrap="nowrap">
          <Text size="xs" c="dimmed">
            {t("{{count}} shown", { count: shownCount })}
          </Text>
          <IconChevronRight size={14} className={classes.menuIcon} />
        </Group>
      </UnstyledButton>
      {view.type === "kanban" && (
        <OptionRow label={t("Direction")}>
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
        </OptionRow>
      )}
      {isTableView(view) && (
        <OptionRow label={t("Row height")}>
          <SegmentedControl
            size="xs"
            value={view.rowHeight}
            onChange={(rowHeight) =>
              patchView(db, { rowHeight: rowHeight as DatabaseRowHeight })
            }
            data={[
              { value: "compact", label: t("Compact") },
              { value: "default", label: t("Default") },
              { value: "comfortable", label: t("Comfortable") },
            ]}
          />
        </OptionRow>
      )}
      {view.type === "kanban" && (
        <OptionRow label={t("Card size")}>
          <SegmentedControl
            size="xs"
            value={view.cardSize}
            onChange={(cardSize) =>
              patchView(db, { cardSize: cardSize as DatabaseCardSize })
            }
            data={[
              { value: "small", label: t("Small") },
              { value: "medium", label: t("Medium") },
              { value: "large", label: t("Large") },
            ]}
          />
        </OptionRow>
      )}
      {(isTableView(view) ||
        (view.type === "kanban" && view.orientation === "vertical")) && (
        <OptionRow label={t("View alignment")}>
          <AlignPicker
            value={view.align}
            onChange={(align) => patchView(db, { align })}
          />
        </OptionRow>
      )}
      {isTableView(view) && (
        <OptionRow label={t("Cell alignment")}>
          <AlignPicker
            value={sharedAlign}
            onChange={(align) =>
              patchView(db, {
                columns: view.columns.map((entry) => ({ ...entry, align })),
              })
            }
          />
        </OptionRow>
      )}
      {(isTableView(view) || view.type === "kanban") && view.groupBy && (
        <OptionRow label={t("Hide empty groups")}>
          <Switch
            size="xs"
            aria-label={t("Hide empty groups")}
            checked={view.hideEmptyGroups}
            onChange={(event) =>
              patchView(db, { hideEmptyGroups: event.currentTarget.checked })
            }
          />
        </OptionRow>
      )}
      {isDateView(view) && (
        <>
          <OptionRow label={t("Start date")}>
            <Select
              size="xs"
              flex={1}
              miw={0}
              aria-label={t("Start date")}
              allowDeselect={false}
              data={ofTypes(["date"])}
              value={view.dateColumnId}
              onChange={(dateColumnId) =>
                dateColumnId && patchView(db, { dateColumnId })
              }
              comboboxProps={NO_PORTAL}
            />
          </OptionRow>
          <OptionRow label={t("End date")}>
            <Select
              size="xs"
              flex={1}
              miw={0}
              aria-label={t("End date")}
              clearable
              placeholder={t("None")}
              data={ofTypes(["date"]).filter(
                (item) => item.value !== view.dateColumnId,
              )}
              value={view.endDateColumnId}
              onChange={(endDateColumnId) => patchView(db, { endDateColumnId })}
              comboboxProps={NO_PORTAL}
            />
          </OptionRow>
        </>
      )}
      {db.views.length > 1 && (
        <>
          <MenuDivider />
          <UnstyledButton
            className={`${classes.optionRow} ${classes.optionDanger}`}
            onClick={() => {
              setOpened(false);
              db.apply((tr, pos) => deleteDatabaseView(tr, pos, view.id));
            }}
          >
            <Group gap={6} wrap="nowrap">
              <IconTrash size={14} />
              <Text className={classes.optionLabel}>{t("Delete view")}</Text>
            </Group>
          </UnstyledButton>
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
