import {
  generateNodeId,
  getDatabaseCellText,
  getDatabaseFilterDefaults,
  insertDatabaseRow,
  setDatabaseCellValue,
  updateDatabaseColumn,
  isDatabaseDate,
  nextDatabaseOptionColor,
  normalizeDatabaseCellValue,
  parseDatabaseNumber,
  readDatabaseValue,
  type DatabaseCellValue,
  type DatabaseColumn,
  type DatabaseRowData,
  type DatabaseSelectOption,
} from "@docmost/editor-ext";
import type { DatabaseContext } from "./database-context";
import { toDateKey } from "./database-utils";

/**
 * Spreadsheet-style copy and paste: cells travel as tab-separated text, so a
 * range copied here pastes into Excel, Feishu or Google Sheets and back.
 */

/** Plain text of one cell, in a form `parseClipboardCell` reads back. */
export function cellToClipboard(
  column: DatabaseColumn,
  row: DatabaseRowData,
  locale: string,
): string {
  const value = readDatabaseValue(column, row);
  switch (column.type) {
    case "number":
    case "progress":
      // Match the paste parser's decimal separator without copying display
      // rounding, currency symbols or grouping separators.
      return typeof value === "number"
        ? value.toLocaleString(locale, {
            useGrouping: false,
            maximumSignificantDigits: 21,
          })
        : "";
    case "date":
      return typeof value === "string" ? value : "";
    case "checkbox":
      return value === true ? "true" : "false";
    case "text":
    case "url":
      return typeof value === "string" ? value : "";
    default:
      return getDatabaseCellText(column, value, locale);
  }
}

function quote(text: string): string {
  return /[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toTSV(matrix: string[][]): string {
  return matrix.map((row) => row.map(quote).join("\t")).join("\n");
}

/** Parses tab-separated text, honoring Excel's quoting (fields with tabs, newlines or quotes). */
export function parseTSV(text: string): string[][] {
  const source = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === "\t") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

const TRUE_WORDS = new Set([
  "true",
  "yes",
  "y",
  "1",
  "x",
  "✓",
  "✔",
  "是",
  "已完成",
]);

function parseDate(text: string): string | null {
  const match = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (match) {
    const key = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    return isDatabaseDate(key) ? key : null;
  }
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : toDateKey(new Date(time));
}

/**
 * Converts pasted text to a value for `column`. Select options are matched by
 * name and created in `options` (mutated, shared across one paste) when
 * missing; members and documents are only matched. Returns undefined to leave
 * the cell unchanged.
 */
export function parseClipboardCell(
  column: DatabaseColumn,
  text: string,
  locale: string,
  options: DatabaseSelectOption[],
): DatabaseCellValue | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  switch (column.type) {
    case "number":
    case "progress": {
      const number = parseDatabaseNumber(trimmed.replace(/%$/, ""), locale);
      return number === null
        ? undefined
        : normalizeDatabaseCellValue(column.type, number);
    }
    case "date":
      return parseDate(trimmed) ?? undefined;
    case "checkbox":
      return TRUE_WORDS.has(trimmed.toLowerCase());
    case "select":
    case "multiSelect":
    case "person":
    case "page": {
      const names =
        column.type === "select"
          ? [trimmed]
          : trimmed.split(/\s*[,，;；、]\s*/).filter(Boolean);
      const ids: string[] = [];
      for (const name of names) {
        const lower = name.toLowerCase();
        let option = options.find(
          (item) => item.name.trim().toLowerCase() === lower,
        );
        if (
          !option &&
          (column.type === "select" || column.type === "multiSelect")
        ) {
          option = {
            id: generateNodeId(),
            name,
            color: nextDatabaseOptionColor(options),
          };
          options.push(option);
        }
        if (option && !ids.includes(option.id)) ids.push(option.id);
      }
      if (column.type === "select") return ids[0] ?? undefined;
      return ids.length ? ids : undefined;
    }
    default:
      return text;
  }
}

/** Pasting more rows than this is cut off; each row is a node in the document. */
const MAX_PASTE_ROWS = 1000;

export function rangeToTSV(
  db: DatabaseContext,
  rows: DatabaseRowData[],
  columns: DatabaseColumn[],
): string {
  return toTSV(
    rows.map((row) =>
      columns.map((column) => cellToClipboard(column, row, db.locale)),
    ),
  );
}

/**
 * Writes pasted text into the table starting at `range.top` / `range.left`
 * (indexes into `rows` / `columns`, the view's order) in one transaction. A
 * single value fills the whole selected range; rows past the end are created.
 * Returns the cells written, for selecting them.
 */
export function pasteIntoTable(
  db: DatabaseContext,
  text: string,
  rows: DatabaseRowData[],
  columns: DatabaseColumn[],
  range: { top: number; left: number; height: number; width: number },
): { rowIds: string[]; columnIds: string[] } | null {
  let matrix = parseTSV(text).slice(0, MAX_PASTE_ROWS);
  if (matrix.length === 1 && matrix[0].length === 1) {
    const [[value]] = matrix;
    matrix = Array.from({ length: range.height }, () =>
      Array(range.width).fill(value),
    );
  }
  const width = Math.max(...matrix.map((line) => line.length));
  const targets = columns.slice(range.left, range.left + width);
  if (!targets.length) return null;

  // Copies, so options created while parsing are written once per column.
  const created = new Map(
    targets
      .filter(
        (column) => column.type === "select" || column.type === "multiSelect",
      )
      .map((column) => [column.id, [...(column.options ?? [])]]),
  );
  const values = matrix.map((line) =>
    targets.map((column, index) =>
      parseClipboardCell(
        column,
        line[index] ?? "",
        db.locale,
        created.get(column.id) ?? column.options ?? [],
      ),
    ),
  );

  const rowIds: string[] = [];
  db.apply((tr, pos) => {
    for (const column of targets) {
      const options = created.get(column.id);
      if (options && options.length !== (column.options?.length ?? 0))
        updateDatabaseColumn(tr, pos, column.id, { options });
    }
    let last = rows[rows.length - 1]?.id ?? null;
    values.forEach((line, index) => {
      const cells: Record<string, DatabaseCellValue> = {};
      targets.forEach((column, i) => {
        if (line[i] !== undefined) cells[column.id] = line[i]!;
      });
      const existing = rows[range.top + index];
      if (existing) {
        for (const [columnId, value] of Object.entries(cells))
          setDatabaseCellValue(tr, pos, existing.id, columnId, value);
        rowIds.push(existing.id);
        return;
      }
      last = insertDatabaseRow(tr, pos, {
        afterRowId: last,
        values: {
          ...getDatabaseFilterDefaults(db.view.filter, db.columns),
          ...db.prepareRow?.(tr, pos),
          ...cells,
        },
      });
      rowIds.push(last);
    });
  });
  return { rowIds, columnIds: targets.map((column) => column.id) };
}
