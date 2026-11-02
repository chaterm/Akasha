import { useState } from "react";
import { Button, CloseButton, Group, Menu, Text } from "@mantine/core";
import { IconPencil, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  deleteDatabaseRow,
  normalizeDatabaseCellValue,
  readDatabaseRows,
  setDatabaseCellValue,
  type DatabaseCellValue,
  type DatabaseColumn,
  type DatabaseRowData,
} from "@docmost/editor-ext";
import { stopBubbling, type DatabaseContext } from "./database-context";
import { CellEditor } from "./database-cells";
import { COLUMN_TYPE_ICONS, COLUMN_TYPE_LABELS } from "./database-ui";
import classes from "./database.module.css";

const same = (a: DatabaseCellValue, b: DatabaseCellValue) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The value every row shares in `column`, or empty when they differ. */
function sharedValue(
  column: DatabaseColumn,
  rows: DatabaseRowData[],
): DatabaseCellValue {
  const values = rows.map((row) =>
    normalizeDatabaseCellValue(column.type, row.values[column.id] ?? null),
  );
  return values.every((value) => same(value, values[0])) ? values[0] : null;
}

/**
 * A context whose edits to the lead row's `column` are copied to every row.
 * The regular cell editors run against a virtual row holding the shared
 * value; after their transaction, a changed lead value is written to all rows
 * and an unchanged one restored, so option-only edits leave the rows alone.
 */
function batchContext(
  db: DatabaseContext,
  column: DatabaseColumn,
  rows: DatabaseRowData[],
): { context: DatabaseContext; row: DatabaseRowData } {
  const lead = rows[0];
  const shared = sharedValue(column, rows);
  const original = normalizeDatabaseCellValue(
    column.type,
    lead.values[column.id] ?? null,
  );
  const context: DatabaseContext = {
    ...db,
    apply: (build) =>
      db.apply((tr, pos) => {
        if (!same(original, shared))
          setDatabaseCellValue(tr, pos, lead.id, column.id, shared);
        build(tr, pos);
        const node = tr.doc.nodeAt(pos);
        const after = node
          ? normalizeDatabaseCellValue(
              column.type,
              readDatabaseRows(node).find((row) => row.id === lead.id)?.values[
                column.id
              ] ?? null,
            )
          : shared;
        if (same(after, shared)) {
          if (!same(original, shared))
            setDatabaseCellValue(tr, pos, lead.id, column.id, original);
          return;
        }
        for (const row of rows.slice(1))
          setDatabaseCellValue(tr, pos, row.id, column.id, after);
      }),
  };
  return {
    context,
    row: { id: lead.id, values: { ...lead.values, [column.id]: shared } },
  };
}

/** Replaces the view bar while rows are checked: count, edit a property for all, delete. */
export function DatabaseBulkBar({
  db,
  rows,
  onClear,
}: {
  db: DatabaseContext;
  /** Checked rows, in view order. */
  rows: DatabaseRowData[];
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<DatabaseColumn | null>(null);
  // The title is unique per row, so it is not offered.
  const editable = db.columns.slice(1);

  const edit = (column: DatabaseColumn) => {
    if (column.type !== "checkbox") return setEditing(column);
    const value = !rows.every((row) => row.values[column.id] === true);
    db.apply((tr, pos) => {
      for (const row of rows)
        setDatabaseCellValue(tr, pos, row.id, column.id, value);
    });
  };

  const trigger = (
    <Button
      size="compact-xs"
      variant="subtle"
      color="gray"
      leftSection={<IconPencil size={14} />}
    >
      {t("Edit property")}
    </Button>
  );
  let editor = null;
  if (editing) {
    const { context, row } = batchContext(db, editing, rows);
    editor = (
      <div className={classes.bulkEditor} {...stopBubbling}>
        <CellEditor
          db={context}
          row={row}
          column={editing}
          anchor={trigger}
          onDone={() => setEditing(null)}
        />
      </div>
    );
  }

  return (
    <Group
      gap={4}
      wrap="nowrap"
      className={classes.bulkBar}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <Text size="sm" fw={500} px={6}>
        {t("{{count}} selected", { count: rows.length })}
      </Text>
      {db.editable && (
        <>
          {editor ?? (
            <Menu shadow="md" position="bottom-start" withinPortal>
              <Menu.Target>{trigger}</Menu.Target>
              <Menu.Dropdown {...stopBubbling}>
                {editable.map((column) => {
                  const TypeIcon = COLUMN_TYPE_ICONS[column.type];
                  return (
                    <Menu.Item
                      key={column.id}
                      leftSection={<TypeIcon size={14} />}
                      onClick={() => edit(column)}
                    >
                      {column.name || t(COLUMN_TYPE_LABELS[column.type])}
                    </Menu.Item>
                  );
                })}
              </Menu.Dropdown>
            </Menu>
          )}
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            leftSection={<IconTrash size={14} />}
            onClick={() => {
              db.apply((tr, pos) => {
                for (const row of rows) deleteDatabaseRow(tr, pos, row.id);
              });
              onClear();
            }}
          >
            {t("Delete")}
          </Button>
        </>
      )}
      <span className={classes.flexSpacer} />
      <CloseButton
        size="sm"
        aria-label={t("Clear selection")}
        onClick={onClear}
      />
    </Group>
  );
}
