import { useEffect, useState, type KeyboardEvent } from "react";
import {
  ActionIcon,
  Button,
  Group,
  MultiSelect,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { DateInput, DatesProvider } from "@mantine/dates";
import { IconFolderPlus, IconPlus, IconTrash } from "@tabler/icons-react";
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
} from "@docmost/editor-ext";
import { getDayjsLocale } from "@/lib/dayjs-locale.ts";
import type { DatabaseContext } from "./database-context";
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
  if (type === "number") {
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
      <MultiSelect
        size="xs"
        flex={1}
        miw={0}
        placeholder={
          column.type === "person"
            ? t("Members")
            : column.type === "page"
              ? t("Pages")
              : t("Options")
        }
        data={(column.options ?? []).map((option) => ({
          value: option.id,
          label: option.name || " ",
        }))}
        value={(condition.value as string[]) ?? []}
        onChange={onChange}
        comboboxProps={NO_PORTAL}
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
}

/** Condition tree editor: and/or per group, nested groups one level deep in the UI. */
export function FilterGroupEditor({
  db,
  group,
  onChange,
  onRemove,
  depth = 1,
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
  const modeSelect = (
    <Select
      size="xs"
      w={72}
      allowDeselect={false}
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
  );

  return (
    <Stack gap={6} className={depth > 1 ? classes.filterGroup : undefined}>
      {group.conditions.map((item, index) => {
        const prefix =
          index === 0 ? (
            <Text size="xs" c="dimmed" w={72}>
              {t("Where")}
            </Text>
          ) : index === 1 ? (
            modeSelect
          ) : (
            <Text size="xs" c="dimmed" w={72}>
              {t(group.mode === "or" ? "Or" : "And")}
            </Text>
          );
        if (item.type === "group") {
          return (
            <Group key={index} gap={6} wrap="nowrap" align="flex-start">
              {prefix}
              <div className={classes.flexFill}>
                <FilterGroupEditor
                  db={db}
                  group={item}
                  depth={depth + 1}
                  onChange={(next) => setAt(index, next)}
                  onRemove={() => setAt(index, null)}
                />
              </div>
            </Group>
          );
        }
        const column = byId.get(item.columnId)!;
        return (
          <Group key={index} gap={6} wrap="nowrap">
            {prefix}
            <Select
              size="xs"
              w={130}
              allowDeselect={false}
              data={columnData}
              value={item.columnId}
              onChange={(columnId) =>
                columnId && setAt(index, newCondition(byId.get(columnId)!))
              }
              comboboxProps={NO_PORTAL}
            />
            <Select
              size="xs"
              w={130}
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
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              aria-label={t("Delete")}
              onClick={() => setAt(index, null)}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        );
      })}
      <Group gap={4}>
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
        {onRemove && (
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            onClick={onRemove}
          >
            {t("Delete group")}
          </Button>
        )}
      </Group>
    </Stack>
  );
}
