import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button, Checkbox, Group, Popover } from "@mantine/core";
import { DatePicker, DatesProvider } from "@mantine/dates";
import { IconCheck } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  getDatabaseCellText,
  getDatabaseUrlHref,
  normalizeDatabaseCellValue,
  parseDatabaseNumber,
  readDatabaseValue,
  setDatabaseCellValue,
  updateDatabaseColumn,
  type DatabaseCellValue,
  type DatabaseColumn,
  type DatabaseRowData,
  type DatabaseSelectOption,
} from "@docmost/editor-ext";
import { getDayjsLocale } from "@/lib/dayjs-locale.ts";
import type { DatabaseContext } from "./database-context";
import { stopBubbling } from "./database-context";
import { ChipList, Highlighted, OptionLabel } from "./database-ui";
import { ReferenceEditor } from "./database-reference";
import { TagSelect } from "./tag-select";
import { parseDateKey } from "./database-utils";
import classes from "./database.module.css";

/**
 * How an editor finished, so the table can move the selection like a spreadsheet.
 * "done": a choice was made in a popover editor; the selection stays on the cell.
 */
export type EditDoneReason =
  | "enter"
  | "tab"
  | "shiftTab"
  | "escape"
  | "blur"
  | "done";

export function writeCell(
  db: DatabaseContext,
  rowId: string,
  columnId: string,
  value: DatabaseCellValue,
) {
  db.apply((tr, pos) => setDatabaseCellValue(tr, pos, rowId, columnId, value));
}

export function formatDateValue(value: string, locale: string): string {
  return parseDateKey(value).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Read-only rendering; returns null for empty values so callers can show a placeholder. */
export function CellDisplay({
  db,
  column,
  row,
  wrap,
}: {
  db: Pick<DatabaseContext, "locale"> & { search?: string };
  column: DatabaseColumn;
  row: DatabaseRowData;
  wrap?: boolean;
}): ReactNode {
  const value = readDatabaseValue(column, row);
  switch (column.type) {
    case "person":
    case "page": {
      const ids = value as string[];
      if (!ids.length) return null;
      return (
        <ChipList
          type={column.type}
          options={ids.map(
            (id) => column.options!.find((option) => option.id === id)!,
          )}
          search={db.search}
          wrap={wrap}
        />
      );
    }
    case "select":
    case "multiSelect": {
      const ids = Array.isArray(value) ? value : value ? [value as string] : [];
      if (!ids.length) return null;
      return (
        <Group
          gap={4}
          wrap={wrap ? "wrap" : "nowrap"}
          className={classes.badges}
        >
          {ids.map((id) => (
            <OptionLabel
              key={id}
              type={column.type}
              option={column.options!.find((option) => option.id === id)!}
              search={db.search}
            />
          ))}
        </Group>
      );
    }
    case "checkbox":
      return value ? <IconCheck size={15} /> : null;
    case "date":
      return value ? (
        <span>
          <Highlighted
            text={formatDateValue(value as string, db.locale)}
            search={db.search}
          />
        </span>
      ) : null;
    case "url": {
      const text = value as string;
      if (!text) return null;
      const href = getDatabaseUrlHref(text);
      return href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={classes.link}
          onClick={(event) => event.stopPropagation()}
        >
          <Highlighted text={text} search={db.search} />
        </a>
      ) : (
        <span>
          <Highlighted text={text} search={db.search} />
        </span>
      );
    }
    default: {
      const text = getDatabaseCellText(column, value, db.locale);
      return text ? (
        <span className={wrap ? undefined : classes.ellipsis}>
          <Highlighted text={text} search={db.search} />
        </span>
      ) : null;
    }
  }
}

function editorKeys(
  event: KeyboardEvent<HTMLElement>,
  commit: () => void,
  cancel: () => void,
  onDone: (reason: EditDoneReason) => void,
) {
  if (event.nativeEvent.isComposing) return;
  if (event.key === "Enter") {
    event.preventDefault();
    commit();
    onDone("enter");
  } else if (event.key === "Tab") {
    event.preventDefault();
    commit();
    onDone(event.shiftKey ? "shiftTab" : "tab");
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancel();
    onDone("escape");
  }
}

interface EditorProps {
  db: DatabaseContext;
  row: DatabaseRowData;
  column: DatabaseColumn;
  /** A typed character that started editing; replaces the current text. */
  initialText?: string;
  onDone: (reason: EditDoneReason) => void;
}

function TextEditor({
  db,
  row,
  column,
  initialText,
  onDone,
  numeric,
}: EditorProps & { numeric?: boolean }) {
  const value = normalizeDatabaseCellValue(
    column.type,
    row.values[column.id] ?? null,
  );
  const original = value === null ? "" : String(value);
  const [draft, setDraft] = useState(initialText ?? original);
  const done = useRef(false);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    if (draft === original) return;
    if (numeric) {
      const number = parseDatabaseNumber(draft, db.locale);
      // Invalid input keeps the old value instead of clearing the cell.
      if (number === null && draft.trim()) return;
      writeCell(db, row.id, column.id, number);
    } else {
      writeCell(db, row.id, column.id, draft);
    }
  };

  return (
    <input
      autoFocus
      className={classes.cellInput}
      data-numeric={numeric || undefined}
      value={draft}
      inputMode={numeric ? "decimal" : undefined}
      onFocus={(event) => {
        if (initialText === undefined) event.currentTarget.select();
      }}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        commit();
        onDone("blur");
      }}
      onKeyDown={(event) =>
        editorKeys(
          event,
          () => commit(),
          () => (done.current = true),
          onDone,
        )
      }
    />
  );
}

interface PopoverEditorProps extends EditorProps {
  /** What the popover is anchored to (the cell's display content). */
  anchor: ReactNode;
}

function SelectEditor({ db, row, column, onDone, anchor }: PopoverEditorProps) {
  const value = readDatabaseValue(column, row);
  const ids = Array.isArray(value) ? value : value ? [value as string] : [];
  const multiple = column.type === "multiSelect";
  return (
    <Popover
      opened
      onChange={(opened) => !opened && onDone("blur")}
      position="bottom-start"
      width={300}
      shadow="md"
      withinPortal
    >
      <Popover.Target>
        <div className={classes.editorAnchor}>{anchor}</div>
      </Popover.Target>
      <Popover.Dropdown {...stopBubbling} p={4}>
        <TagSelect
          options={column.options ?? []}
          value={ids}
          multiple={multiple}
          onChange={(next) =>
            writeCell(
              db,
              row.id,
              column.id,
              multiple ? next : (next[0] ?? null),
            )
          }
          onOptionsChange={(options: DatabaseSelectOption[]) =>
            db.apply((tr, pos) =>
              updateDatabaseColumn(tr, pos, column.id, { options }),
            )
          }
          onClose={() => onDone("done")}
        />
      </Popover.Dropdown>
    </Popover>
  );
}

function DateEditor({ db, row, column, onDone, anchor }: PopoverEditorProps) {
  const { t } = useTranslation();
  const value = normalizeDatabaseCellValue(
    "date",
    row.values[column.id] ?? null,
  ) as string | null;
  const write = (next: string | null) => {
    writeCell(db, row.id, column.id, next);
    onDone("done");
  };
  return (
    <Popover
      opened
      onChange={(opened) => !opened && onDone("blur")}
      position="bottom-start"
      shadow="md"
      trapFocus
      withinPortal
    >
      <Popover.Target>
        <div className={classes.editorAnchor}>{anchor}</div>
      </Popover.Target>
      <Popover.Dropdown {...stopBubbling} p="xs">
        <DatesProvider settings={{ locale: getDayjsLocale(db.locale) }}>
          <DatePicker
            size="xs"
            value={value}
            defaultDate={value ?? undefined}
            onChange={(next) => write(next ? String(next).slice(0, 10) : null)}
          />
        </DatesProvider>
        {value && (
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            fullWidth
            mt={4}
            onClick={() => write(null)}
          >
            {t("Clear")}
          </Button>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}

/** The editor for one cell. Checkbox has none: callers toggle it directly. */
export function CellEditor(props: PopoverEditorProps) {
  switch (props.column.type) {
    case "select":
    case "multiSelect":
      return <SelectEditor {...props} />;
    case "person":
    case "page":
      return <ReferenceEditor {...props} onDone={() => props.onDone("done")} />;
    case "date":
      return <DateEditor {...props} />;
    case "number":
      return <TextEditor {...props} numeric />;
    case "checkbox":
      return <>{props.anchor}</>;
    default:
      return <TextEditor {...props} />;
  }
}

export function toggleCheckbox(
  db: DatabaseContext,
  row: DatabaseRowData,
  column: DatabaseColumn,
) {
  writeCell(db, row.id, column.id, row.values[column.id] !== true);
}

/**
 * Click-to-edit value used outside the table (row detail, kanban cards).
 * `onEditingChange` lets a parent modal disable its own Escape handling.
 */
export function FieldValue({
  db,
  row,
  column,
  placeholder,
  onEditingChange,
  editOnDoubleClick,
}: {
  db: DatabaseContext;
  row: DatabaseRowData;
  column: DatabaseColumn;
  placeholder?: string;
  onEditingChange?: (editing: boolean) => void;
  /** On draggable cards a single click must stay free for dragging. */
  editOnDoubleClick?: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditingState] = useState(false);
  const editingRef = useRef(false);
  const setEditing = (next: boolean) => {
    if (editingRef.current === next) return;
    editingRef.current = next;
    setEditingState(next);
    onEditingChange?.(next);
  };
  // Unmounting mid-edit (row deleted, modal closed) must still release the parent's count.
  useEffect(
    () => () => {
      if (editingRef.current) onEditingChange?.(false);
    },
    [],
  );

  if (column.type === "checkbox") {
    return (
      <Checkbox
        size="xs"
        checked={row.values[column.id] === true}
        disabled={!db.editable}
        onChange={() => toggleCheckbox(db, row, column)}
      />
    );
  }

  // CellDisplay has no hooks, so it can be called to learn whether the value is empty.
  const shown = CellDisplay({ db, column, row, wrap: true });
  const anchor = (
    <div className={classes.fieldDisplay}>
      {shown ?? (
        <span className={classes.placeholder}>{placeholder ?? t("Empty")}</span>
      )}
    </div>
  );

  if (!db.editable) return anchor;
  if (editing) {
    return (
      <div className={classes.fieldEditing} data-editing>
        <CellEditor
          db={db}
          row={row}
          column={column}
          anchor={anchor}
          onDone={() => setEditing(false)}
        />
      </div>
    );
  }
  return (
    <div
      role="button"
      tabIndex={0}
      className={classes.fieldValue}
      onClick={editOnDoubleClick ? undefined : () => setEditing(true)}
      onDoubleClick={editOnDoubleClick ? () => setEditing(true) : undefined}
      onKeyDown={(event) => {
        if (event.key === "Enter") setEditing(true);
      }}
    >
      {anchor}
    </div>
  );
}
