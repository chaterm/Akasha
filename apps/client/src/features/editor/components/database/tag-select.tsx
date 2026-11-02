import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ActionIcon,
  Button,
  ColorSwatch,
  Group,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { IconCheck, IconDots, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  generateNodeId,
  nextDatabaseOptionColor,
  DATABASE_COLORS,
  type DatabaseSelectOption,
} from "@docmost/editor-ext";
import { MenuBack, OptionBadge } from "./database-ui";
import { SortableList } from "./sortable-list";
import { DATABASE_COLOR_MAP, moveItem } from "./database-utils";
import classes from "./database.module.css";

interface TagSelectProps {
  options: DatabaseSelectOption[];
  value: string[];
  multiple: boolean;
  onChange: (ids: string[]) => void;
  /** Writes the option list (create, rename, recolor, delete, reorder). Omit to make options read-only. */
  onOptionsChange?: (options: DatabaseSelectOption[]) => void;
  /** Called when the user is done: single choice made, or Escape. */
  onClose: () => void;
}

/**
 * Dropdown body for select / multiSelect values. Single select replaces and
 * closes; multi select only adds on click and removes via × or Backspace.
 * Option settings open as a second page instead of a nested popover.
 */
export function TagSelect({
  options,
  value,
  multiple,
  onChange,
  onOptionsChange,
  onClose,
}: TagSelectProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const known = useMemo(
    () => new Map(options.map((option) => [option.id, option])),
    [options],
  );
  const selected = value.filter((id) => known.has(id));
  const trimmed = query.trim();
  const filtered = options.filter((option) =>
    option.name.toLowerCase().includes(trimmed.toLowerCase()),
  );
  const canCreate =
    !!onOptionsChange &&
    !!trimmed &&
    !options.some((option) => option.name === trimmed);
  const itemCount = filtered.length + (canCreate ? 1 : 0);

  useEffect(() => setActive(0), [trimmed]);
  useEffect(() => {
    listRef.current
      ?.querySelector("[data-active]")
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (id: string) => {
    if (multiple) {
      if (!selected.includes(id)) onChange([...selected, id]);
      setQuery("");
      inputRef.current?.focus();
    } else {
      onChange([id]);
      onClose();
    }
  };

  const create = () => {
    if (!canCreate) return;
    const option: DatabaseSelectOption = {
      id: generateNodeId(),
      name: trimmed,
      color: nextDatabaseOptionColor(options),
    };
    onOptionsChange!([...options, option]);
    choose(option.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!itemCount) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + delta + itemCount) % itemCount);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active < filtered.length) choose(filtered[active].id);
      else create();
    } else if (
      event.key === "Backspace" &&
      !query &&
      multiple &&
      selected.length
    ) {
      onChange(selected.slice(0, -1));
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const editing = editingId ? known.get(editingId) : null;
  if (editing && onOptionsChange) {
    return (
      <OptionSettings
        option={editing}
        onChange={(patch) =>
          onOptionsChange(
            options.map((option) =>
              option.id === editing.id ? { ...option, ...patch } : option,
            ),
          )
        }
        onDelete={() => {
          setEditingId(null);
          onOptionsChange(options.filter((option) => option.id !== editing.id));
        }}
        onBack={() => {
          setEditingId(null);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      />
    );
  }

  const renderOption = (option: DatabaseSelectOption, index: number) => (
    <UnstyledButton
      className={classes.tagOption}
      data-active={index === active || undefined}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => setActive(index)}
      onClick={() => choose(option.id)}
    >
      <OptionBadge option={option} />
      <Group gap={2} wrap="nowrap">
        {selected.includes(option.id) && <IconCheck size={14} />}
        {onOptionsChange && (
          <ActionIcon
            size="xs"
            variant="subtle"
            color="gray"
            className={classes.tagOptionMore}
            aria-label={t("Edit option")}
            onClick={(event) => {
              event.stopPropagation();
              setEditingId(option.id);
            }}
          >
            <IconDots size={12} />
          </ActionIcon>
        )}
      </Group>
    </UnstyledButton>
  );

  return (
    <div>
      <div
        className={classes.tagInputBox}
        onClick={() => inputRef.current?.focus()}
      >
        {selected.map((id) => (
          <OptionBadge
            key={id}
            option={known.get(id)!}
            onRemove={() => onChange(selected.filter((item) => item !== id))}
          />
        ))}
        <input
          ref={inputRef}
          autoFocus
          className={classes.tagInput}
          value={query}
          placeholder={selected.length ? "" : t("Search or create an option")}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <Text size="xs" c="dimmed" px={8} pt={6} pb={2}>
        {onOptionsChange
          ? t("Select an option or create one")
          : t("Select an option")}
      </Text>
      <div ref={listRef} className={classes.tagList}>
        {trimmed || !onOptionsChange ? (
          filtered.map((option, index) => (
            <div key={option.id}>{renderOption(option, index)}</div>
          ))
        ) : (
          <SortableList
            items={options}
            getKey={(option) => option.id}
            onMove={(from, to) => onOptionsChange(moveItem(options, from, to))}
            renderItem={renderOption}
          />
        )}
        {canCreate && (
          <UnstyledButton
            className={classes.tagOption}
            data-active={active === filtered.length || undefined}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActive(filtered.length)}
            onClick={create}
          >
            <Group gap={6} wrap="nowrap">
              <Text size="xs">{t("Create")}</Text>
              <OptionBadge
                option={{
                  id: "",
                  name: trimmed,
                  color: nextDatabaseOptionColor(options),
                }}
              />
            </Group>
          </UnstyledButton>
        )}
      </div>
    </div>
  );
}

/** Rename / recolor / delete one option. Also used by kanban group headers. */
export function OptionSettings({
  option,
  onChange,
  onDelete,
  onBack,
}: {
  option: DatabaseSelectOption;
  onChange: (patch: Partial<DatabaseSelectOption>) => void;
  onDelete: () => void;
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(option.name);
  useEffect(() => setName(option.name), [option.name]);
  const commit = () => {
    if (name !== option.name) onChange({ name });
  };

  return (
    <Stack gap={8}>
      {onBack && (
        <MenuBack
          label={t("Edit option")}
          onBack={() => {
            commit();
            onBack();
          }}
        />
      )}
      <TextInput
        size="xs"
        autoFocus
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            onBack?.();
          }
          if (event.key === "Escape" && onBack) {
            event.stopPropagation();
            onBack();
          }
        }}
      />
      <Group gap={6}>
        {DATABASE_COLORS.map((color) => (
          <ColorSwatch
            key={color}
            component="button"
            size={20}
            color={`var(--mantine-color-${DATABASE_COLOR_MAP[color]}-4)`}
            aria-label={color}
            onClick={() => onChange({ color })}
          >
            {option.color === color && <IconCheck size={12} color="white" />}
          </ColorSwatch>
        ))}
      </Group>
      <Button
        size="xs"
        variant="subtle"
        color="red"
        justify="flex-start"
        leftSection={<IconTrash size={14} />}
        onClick={onDelete}
      >
        {t("Delete option")}
      </Button>
    </Stack>
  );
}
