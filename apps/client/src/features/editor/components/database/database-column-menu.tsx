import { useEffect, useState, type ReactNode } from "react";
import { ActionIcon, Group, Popover, Text, TextInput } from "@mantine/core";
import {
  IconLayoutAlignLeft,
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconColumnInsertLeft,
  IconColumnInsertRight,
  IconCopy,
  IconEyeOff,
  IconMinus,
  IconPlus,
  IconSortAscending,
  IconSortDescending,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  addDatabaseColumn,
  changeDatabaseColumnType,
  deleteDatabaseColumn,
  duplicateDatabaseColumn,
  formatDatabaseNumber,
  updateDatabaseColumn,
  DATABASE_NUMBER_FORMATS,
  type DatabaseColumn,
  type DatabaseNumberFormat,
} from "@docmost/editor-ext";
import {
  columnAlign,
  stopBubbling,
  patchView,
  type DatabaseContext,
} from "./database-context";
import {
  ADDABLE_COLUMN_TYPES,
  AlignPicker,
  COLUMN_TYPE_ICONS,
  COLUMN_TYPE_LABELS,
  MenuBack,
  MenuDivider,
  MenuRow,
} from "./database-ui";
import classes from "./database.module.css";

const NUMBER_FORMAT_LABELS: Record<DatabaseNumberFormat, string> = {
  number: "Number",
  commas: "Number with commas",
  percent: "Percent",
  CNY: "Yuan",
  USD: "US dollar",
  EUR: "Euro",
  GBP: "Pound",
  JPY: "Yen",
};

/** Moves a column one visible step left/right in the active view. */
function moveColumnInView(
  db: DatabaseContext,
  columnId: string,
  delta: -1 | 1,
) {
  const entries = [...db.view.columns];
  const index = entries.findIndex((entry) => entry.id === columnId);
  let target = index + delta;
  while (target >= 0 && target < entries.length && entries[target].hidden)
    target += delta;
  if (index < 0 || target < 0 || target >= entries.length) return;
  [entries[index], entries[target]] = [entries[target], entries[index]];
  patchView(db, { columns: entries });
}

interface ColumnMenuProps {
  db: DatabaseContext;
  column: DatabaseColumn;
  opened: boolean;
  onClose: () => void;
  /** A column was inserted next to this one; the caller usually opens its menu. */
  onInserted?: (columnId: string) => void;
  children: ReactNode;
  position?: "bottom-start" | "right-start";
  /** Offer the view's cell alignment (table only). */
  alignable?: boolean;
}

export function ColumnMenu({
  db,
  column,
  opened,
  onClose,
  onInserted,
  children,
  position = "bottom-start",
  alignable,
}: ColumnMenuProps) {
  const { t } = useTranslation();
  const [page, setPage] = useState<"main" | "type" | "format">("main");
  const [name, setName] = useState(column.name);
  useEffect(() => {
    if (opened) {
      setPage("main");
      setName(column.name);
    }
  }, [opened, column.name]);

  const commitName = () => {
    if (name !== column.name) {
      db.apply((tr, pos) => updateDatabaseColumn(tr, pos, column.id, { name }));
    }
  };
  const run = (action: () => void) => {
    commitName();
    action();
    onClose();
  };
  const insert = (side: "left" | "right") =>
    run(() => {
      let id = "";
      db.apply((tr, pos) => {
        id = addDatabaseColumn(
          tr,
          pos,
          { name: t("Text"), type: "text" },
          { anchorId: column.id, side },
        );
      });
      if (id) setTimeout(() => onInserted?.(id), 0);
    });
  const visible = db.view.columns
    .filter((entry) => !entry.hidden)
    .map((entry) => entry.id);
  const visibleIndex = visible.indexOf(column.id);

  const TypeIcon = COLUMN_TYPE_ICONS[column.type];
  const main = (
    <>
      <TextInput
        size="xs"
        autoFocus
        mb={4}
        value={name}
        leftSection={<TypeIcon size={14} />}
        onChange={(event) => setName(event.currentTarget.value)}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === "Enter") run(() => {});
        }}
      />
      <MenuRow
        icon={TypeIcon}
        label={t("Type")}
        hint={t(COLUMN_TYPE_LABELS[column.type])}
        submenu
        onClick={() => setPage("type")}
      />
      {column.type === "number" && (
        <MenuRow
          label={t("Number format")}
          hint={t(NUMBER_FORMAT_LABELS[column.format ?? "number"])}
          submenu
          onClick={() => setPage("format")}
        />
      )}
      {alignable && (
        <Group justify="space-between" px={8} py={2} wrap="nowrap">
          <Group gap={8} wrap="nowrap">
            <IconLayoutAlignLeft size={15} className={classes.menuIcon} />
            <Text size="sm">{t("Cell alignment")}</Text>
          </Group>
          <AlignPicker
            value={columnAlign(db, column)}
            onChange={(align) =>
              patchView(db, {
                columns: db.view.columns.map((entry) =>
                  entry.id === column.id ? { ...entry, align } : entry,
                ),
              })
            }
          />
        </Group>
      )}
      <MenuDivider />
      <MenuRow
        icon={IconSortAscending}
        label={t("Sort ascending")}
        onClick={() =>
          run(() =>
            patchView(db, {
              sorts: [{ columnId: column.id, direction: "asc" }],
            }),
          )
        }
      />
      <MenuRow
        icon={IconSortDescending}
        label={t("Sort descending")}
        onClick={() =>
          run(() =>
            patchView(db, {
              sorts: [{ columnId: column.id, direction: "desc" }],
            }),
          )
        }
      />
      <MenuRow
        icon={IconEyeOff}
        label={t("Hide in view")}
        onClick={() =>
          run(() =>
            patchView(db, {
              columns: db.view.columns.map((entry) =>
                entry.id === column.id ? { ...entry, hidden: true } : entry,
              ),
            }),
          )
        }
      />
      <MenuDivider />
      <MenuRow
        icon={IconColumnInsertLeft}
        label={t("Insert left")}
        onClick={() => insert("left")}
      />
      <MenuRow
        icon={IconColumnInsertRight}
        label={t("Insert right")}
        onClick={() => insert("right")}
      />
      {visibleIndex > 0 && (
        <MenuRow
          icon={IconArrowLeft}
          label={t("Move left")}
          onClick={() => run(() => moveColumnInView(db, column.id, -1))}
        />
      )}
      {visibleIndex < visible.length - 1 && (
        <MenuRow
          icon={IconArrowRight}
          label={t("Move right")}
          onClick={() => run(() => moveColumnInView(db, column.id, 1))}
        />
      )}
      <MenuRow
        icon={IconCopy}
        label={t("Duplicate")}
        onClick={() =>
          run(() =>
            db.apply((tr, pos) =>
              duplicateDatabaseColumn(
                tr,
                pos,
                column.id,
                `${name || column.name} ${t("copy")}`,
              ),
            ),
          )
        }
      />
      {db.columns.length > 1 && (
        <MenuRow
          icon={IconTrash}
          label={t("Delete column")}
          danger
          onClick={() =>
            run(() =>
              db.apply((tr, pos) => deleteDatabaseColumn(tr, pos, column.id)),
            )
          }
        />
      )}
    </>
  );

  const typePage = (
    <>
      <MenuBack label={t("Type")} onBack={() => setPage("main")} />
      {ADDABLE_COLUMN_TYPES.map((type) => (
        <MenuRow
          key={type}
          icon={COLUMN_TYPE_ICONS[type]}
          label={t(COLUMN_TYPE_LABELS[type])}
          active={type === column.type}
          hint={type === column.type ? <IconCheck size={14} /> : undefined}
          onClick={() =>
            run(() =>
              db.apply((tr, pos) => {
                changeDatabaseColumnType(tr, pos, column.id, type);
                // A name that is still the old type's default follows the new type.
                const current = name.trim();
                if (!current || current === t(COLUMN_TYPE_LABELS[column.type]))
                  updateDatabaseColumn(tr, pos, column.id, {
                    name: t(COLUMN_TYPE_LABELS[type]),
                  });
              }),
            )
          }
        />
      ))}
    </>
  );

  const decimals = column.decimals ?? null;
  const setFormat = (
    patch: Partial<Pick<DatabaseColumn, "format" | "decimals">>,
  ) => db.apply((tr, pos) => updateDatabaseColumn(tr, pos, column.id, patch));
  const formatPage = (
    <>
      <MenuBack label={t("Number format")} onBack={() => setPage("main")} />
      {DATABASE_NUMBER_FORMATS.map((format) => (
        <MenuRow
          key={format}
          label={t(NUMBER_FORMAT_LABELS[format])}
          hint={formatDatabaseNumber(1234.5, { format, decimals }, db.locale)}
          active={format === (column.format ?? "number")}
          onClick={() => setFormat({ format })}
        />
      ))}
      <MenuDivider />
      <Group justify="space-between" px={8} py={4} wrap="nowrap">
        <Text size="sm">{t("Decimal places")}</Text>
        <Group gap={4} wrap="nowrap">
          <ActionIcon
            size="sm"
            variant="default"
            aria-label="-"
            disabled={decimals === null}
            onClick={() =>
              setFormat({ decimals: decimals ? decimals - 1 : null })
            }
          >
            <IconMinus size={12} />
          </ActionIcon>
          <Text size="sm" w={36} ta="center">
            {decimals === null ? t("Auto") : decimals}
          </Text>
          <ActionIcon
            size="sm"
            variant="default"
            aria-label="+"
            disabled={decimals === 8}
            onClick={() =>
              setFormat({ decimals: decimals === null ? 0 : decimals + 1 })
            }
          >
            <IconPlus size={12} />
          </ActionIcon>
        </Group>
      </Group>
    </>
  );

  return (
    <Popover
      opened={opened}
      onChange={(next) => {
        if (!next) {
          commitName();
          onClose();
        }
      }}
      position={position}
      width={260}
      shadow="md"
      withinPortal
    >
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown {...stopBubbling} p={4} className={classes.menu}>
        {page === "type" ? typePage : page === "format" ? formatPage : main}
      </Popover.Dropdown>
    </Popover>
  );
}
