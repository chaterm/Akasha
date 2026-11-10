import {
  useEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ActionIcon,
  Button,
  Checkbox,
  CloseButton,
  Combobox,
  Group,
  Input,
  InputBase,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
  useCombobox,
} from "@mantine/core";
import { DateInput, DatesProvider } from "@mantine/dates";
import {
  IconChevronDown,
  IconFolderPlus,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  databaseFilterNeedsValue,
  getDatabaseFilterOperators,
  hasDatabaseOptions,
  type DatabaseColumn,
  type DatabaseColumnType,
  type DatabaseFilterCondition,
  type DatabaseFilterGroup,
  type DatabaseFilterOperator,
  type DatabaseSelectOption,
} from "@docmost/editor-ext";
import { getDayjsLocale } from "@/lib/dayjs-locale.ts";
import type { DatabaseContext } from "./database-context";
import { COLUMN_TYPE_ICONS } from "./database-ui";
import classes from "./database.module.css";

const OPERATOR_LABELS: Record<DatabaseFilterOperator, string> = {
  contains: "contains",
  notContains: "does not contain",
  is: "is",
  isNot: "is not",
  startsWith: "starts with",
  endsWith: "ends with",
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  before: "is before",
  after: "is after",
  onOrBefore: "is on or before",
  onOrAfter: "is on or after",
  isAnyOf: "is any of",
  isNoneOf: "is none of",
  hasAnyOf: "has any of",
  hasAllOf: "has all of",
  hasNoneOf: "has none of",
  isChecked: "is checked",
  isUnchecked: "is unchecked",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
};

const NO_PORTAL = { withinPortal: false };

export function newCondition(column: DatabaseColumn): DatabaseFilterCondition {
  return {
    type: "condition",
    columnId: column.id,
    op: getDatabaseFilterOperators(column.type)[0],
    value: null,
  };
}

/** Text/number inputs commit on blur or Enter so typing is one transaction. */
function BufferedInput({
  type,
  value,
  onCommit,
}: {
  type: DatabaseColumnType;
  value: unknown;
  onCommit: (value: unknown) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | number>(
    value === null || value === undefined ? "" : (value as string | number),
  );
  useEffect(
    () =>
      setDraft(
        value === null || value === undefined ? "" : (value as string | number),
      ),
    [value],
  );
  const commit = () => draft !== value && onCommit(draft === "" ? null : draft);
  const shared = {
    size: "xs" as const,
    flex: 1,
    miw: 0,
    placeholder: t("Value"),
    onBlur: commit,
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") commit();
    },
  };
  if (type === "number" || type === "progress") {
    return (
      <NumberInput
        {...shared}
        value={draft}
        hideControls
        onChange={(next) => setDraft(next)}
      />
    );
  }
  return (
    <TextInput
      {...shared}
      value={String(draft)}
      onChange={(event) => setDraft(event.currentTarget.value)}
    />
  );
}

function OptionCheckSelect({
  options,
  value,
  onChange,
  placeholder,
}: {
  options: DatabaseSelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder: string;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const combobox = useCombobox({
    onDropdownClose: () => {
      combobox.resetSelectedOption();
      setSearch("");
    },
    onDropdownOpen: () => combobox.focusSearchInput(),
  });
  const selected = new Set(value);
  const names = options
    .filter((option) => selected.has(option.id))
    .map((option) => option.name || t("Untitled"));
  const query = search.trim().toLowerCase();
  const shown = options.filter((option) =>
    (option.name || "").toLowerCase().includes(query),
  );
  const toggle = (id: string) =>
    onChange(
      selected.has(id) ? value.filter((item) => item !== id) : [...value, id],
    );

  return (
    <Combobox
      store={combobox}
      withinPortal={false}
      onOptionSubmit={toggle}
    >
      <Combobox.Target>
        <InputBase
          component="button"
          type="button"
          size="xs"
          flex={1}
          miw={0}
          pointer
          rightSection={
            <Group gap={2} wrap="nowrap">
              {value.length > 0 && (
                <CloseButton
                  size="xs"
                  aria-label={t("Clear")}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onChange([]);
                  }}
                />
              )}
              <ActionIcon
                size="xs"
                variant="transparent"
                color="gray"
                aria-label={t(combobox.dropdownOpened ? "Collapse" : "Expand")}
                aria-expanded={combobox.dropdownOpened}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  combobox.toggleDropdown();
                }}
              >
                <IconChevronDown
                  size={14}
                  className={classes.checkSelectChevron}
                  data-open={combobox.dropdownOpened || undefined}
                />
              </ActionIcon>
            </Group>
          }
          rightSectionWidth={value.length ? 48 : 28}
          rightSectionPointerEvents="all"
          onClick={() => combobox.toggleDropdown()}
        >
          {names.length ? (
            <span className={classes.checkSelectValue} title={names.join(", ")}>
              {names.join(", ")}
            </span>
          ) : (
            <Input.Placeholder>{placeholder}</Input.Placeholder>
          )}
        </InputBase>
      </Combobox.Target>
      <Combobox.Dropdown>
        <Combobox.Search
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder={t("Search")}
        />
        <Combobox.Options mah={240} style={{ overflowY: "auto" }}>
          {shown.length ? (
            shown.map((option) => (
              <Combobox.Option
                key={option.id}
                value={option.id}
                active={selected.has(option.id)}
              >
                <Group gap={8} wrap="nowrap">
                  <Checkbox
                    size="xs"
                    checked={selected.has(option.id)}
                    readOnly
                    tabIndex={-1}
                    aria-hidden
                    style={{ pointerEvents: "none" }}
                  />
                  <span className={classes.ellipsis}>
                    {option.name || t("Untitled")}
                  </span>
                </Group>
              </Combobox.Option>
            ))
          ) : (
            <Combobox.Empty>{t("No results")}</Combobox.Empty>
          )}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}

function ValueInput({
  db,
  column,
  condition,
  onChange,
}: {
  db: DatabaseContext;
  column: DatabaseColumn;
  condition: DatabaseFilterCondition;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation();
  if (!databaseFilterNeedsValue(condition.op))
    return <span className={classes.flexSpacer} />;
  if (column.type === "date") {
    return (
      <DatesProvider settings={{ locale: getDayjsLocale(db.locale) }}>
        <DateInput
          size="xs"
          flex={1}
          miw={0}
          clearable
          valueFormat="YYYY-MM-DD"
          placeholder={t("Date")}
          value={(condition.value as string) || null}
          onChange={(next) => onChange(next ? String(next).slice(0, 10) : null)}
          popoverProps={NO_PORTAL}
        />
      </DatesProvider>
    );
  }
  if (hasDatabaseOptions(column.type)) {
    return (
      <OptionCheckSelect
        options={column.options ?? []}
        value={(condition.value as string[]) ?? []}
        onChange={onChange}
        placeholder={
          column.type === "person"
            ? t("Members")
            : column.type === "page"
              ? t("Pages")
              : t("Options")
        }
      />
    );
  }
  return (
    <BufferedInput
      type={column.type}
      value={condition.value}
      onCommit={onChange}
    />
  );
}

interface GroupEditorProps {
  db: DatabaseContext;
  group: DatabaseFilterGroup;
  onChange: (group: DatabaseFilterGroup) => void;
  onRemove?: () => void;
  depth?: number;
  actions?: ReactNode;
}

/** Condition tree editor: and/or per group, nested groups one level deep in the UI. */
export function FilterGroupEditor({
  db,
  group,
  onChange,
  onRemove,
  depth = 1,
  actions,
}: GroupEditorProps) {
  const { t } = useTranslation();
  const byId = new Map(db.columns.map((column) => [column.id, column]));
  const columnData = db.columns.map((column) => ({
    value: column.id,
    label: column.name || t("Untitled"),
  }));
  const setAt = (
    index: number,
    item: DatabaseFilterGroup["conditions"][number] | null,
  ) => {
    const conditions = [...group.conditions];
    if (item) conditions[index] = item;
    else conditions.splice(index, 1);
    onChange({ ...group, conditions });
  };
  const prefix = (index: number) => (
    <div className={classes.filterPrefix}>
      {index === 0 ? (
        <Text size="xs" c="dimmed">
          {t("Where")}
        </Text>
      ) : index === 1 ? (
        <Select
          size="xs"
          allowDeselect={false}
          aria-label={t("Match")}
          data={[
            { value: "and", label: t("And") },
            { value: "or", label: t("Or") },
          ]}
          value={group.mode}
          onChange={(mode) =>
            onChange({ ...group, mode: mode === "or" ? "or" : "and" })
          }
          comboboxProps={NO_PORTAL}
        />
      ) : (
        <Text size="xs" c="dimmed">
          {t(group.mode === "or" ? "Or" : "And")}
        </Text>
      )}
    </div>
  );
  const deleteButton = (onClick: () => void, label: string) => (
    <ActionIcon
      size="sm"
      variant="subtle"
      color="gray"
      aria-label={label}
      onClick={onClick}
    >
      <IconTrash size={14} />
    </ActionIcon>
  );

  return (
    <Stack gap={6} className={depth > 1 ? classes.filterGroup : undefined}>
      {onRemove && (
        <Group gap={6} wrap="nowrap" justify="space-between">
          <Text size="xs" c="dimmed">
            {t("Filter group")}
          </Text>
          {deleteButton(onRemove, t("Delete filter group"))}
        </Group>
      )}
      {group.conditions.map((item, index) => {
        if (item.type === "group") {
          return (
            <Group key={index} gap={6} wrap="nowrap" align="flex-start">
              {prefix(index)}
              <div className={classes.flexFill}>
                <FilterGroupEditor
                  db={db}
                  group={item}
                  depth={depth + 1}
                  // An emptied group is removed.
                  onChange={(next) =>
                    setAt(index, next.conditions.length ? next : null)
                  }
                  onRemove={() => setAt(index, null)}
                />
              </div>
            </Group>
          );
        }
        const column = byId.get(item.columnId)!;
        const TypeIcon = COLUMN_TYPE_ICONS[column.type];
        return (
          <Group key={index} gap={6} wrap="nowrap">
            {prefix(index)}
            <Select
              size="xs"
              w={128}
              allowDeselect={false}
              aria-label={t("Field")}
              leftSection={<TypeIcon size={13} />}
              data={columnData}
              value={item.columnId}
              onChange={(columnId) =>
                columnId && setAt(index, newCondition(byId.get(columnId)!))
              }
              comboboxProps={NO_PORTAL}
            />
            <Select
              size="xs"
              w={112}
              aria-label={t("Condition")}
              allowDeselect={false}
              data={getDatabaseFilterOperators(column.type).map((op) => ({
                value: op,
                label: t(OPERATOR_LABELS[op]),
              }))}
              value={item.op}
              onChange={(op) =>
                op &&
                setAt(index, { ...item, op: op as DatabaseFilterOperator })
              }
              comboboxProps={NO_PORTAL}
            />
            <ValueInput
              db={db}
              column={column}
              condition={item}
              onChange={(value) =>
                setAt(index, {
                  ...item,
                  value: value as DatabaseFilterCondition["value"],
                })
              }
            />
            {deleteButton(() => setAt(index, null), t("Delete"))}
          </Group>
        );
      })}
      <Group gap={4} className={depth === 1 ? classes.filterActions : undefined}>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          leftSection={<IconPlus size={12} />}
          onClick={() =>
            onChange({
              ...group,
              conditions: [...group.conditions, newCondition(db.columns[0])],
            })
          }
        >
          {t("Add filter")}
        </Button>
        {depth === 1 && (
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            leftSection={<IconFolderPlus size={12} />}
            onClick={() =>
              onChange({
                ...group,
                conditions: [
                  ...group.conditions,
                  {
                    type: "group",
                    mode: "and",
                    conditions: [newCondition(db.columns[0])],
                  },
                ],
              })
            }
          >
            {t("Add filter group")}
          </Button>
        )}
        {actions && (
          <Group gap={6} wrap="nowrap" ml="auto">
            {actions}
          </Group>
        )}
      </Group>
    </Stack>
  );
}
