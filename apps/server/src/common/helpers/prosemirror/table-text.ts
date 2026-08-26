export type KnowledgeTableRow = {
  tableIndex: number;
  rowIndex: number;
  text: string;
};

export function hasTableNode(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'table') return true;
  return Array.isArray(value.content)
    ? value.content.some((child) => hasTableNode(child))
    : false;
}

export function extractKnowledgeTableRows(value: unknown): KnowledgeTableRow[] {
  const rows: KnowledgeTableRow[] = [];
  let tableIndex = 0;
  walk(value, (node) => {
    if (node.type !== 'table') return;
    const tableRows = Array.isArray(node.content)
      ? node.content.filter(
          (child): child is Record<string, unknown> =>
            isRecord(child) && child.type === 'tableRow',
        )
      : [];
    rows.push(...serializeTableRows(tableRows, tableIndex));
    tableIndex += 1;
  });
  return rows;
}

export function serializeTableNode(value: unknown): string[] {
  if (!isRecord(value) || value.type !== 'table') return [];
  const tableRows = Array.isArray(value.content)
    ? value.content.filter(
        (child): child is Record<string, unknown> =>
          isRecord(child) && child.type === 'tableRow',
      )
    : [];
  if (tableRows.length === 0) return [];
  const normalized = normalizeTableRows(tableRows);
  const hasHeader = rowCells(tableRows[0]).some(
    (cell) => cell.type === 'tableHeader',
  );
  const headers = hasHeader ? headerLabels(normalized[0]) : [];
  const dataRows = hasHeader ? normalized.slice(1) : normalized;
  const lines = hasHeader ? [`Headers: ${headers.join('; ')}`] : [];

  for (const row of dataRows) {
    const values = row.map((cell) => cellText(cell ?? {}));
    const labels = headers.length
      ? headers
      : values.map((_, index) => `Column ${index + 1}`);
    lines.push(formatRow(labels, values));
  }

  return lines.filter(Boolean);
}

function serializeTableRows(
  tableRows: Record<string, unknown>[],
  tableIndex: number,
): KnowledgeTableRow[] {
  if (tableRows.length === 0) return [];
  const normalized = normalizeTableRows(tableRows);
  const hasHeader = rowCells(tableRows[0]).some(
    (cell) => cell.type === 'tableHeader',
  );
  const headers = hasHeader ? headerLabels(normalized[0]) : [];
  const dataRows = hasHeader ? normalized.slice(1) : normalized;

  return dataRows.map((row, index) => {
    const values = row.map((cell) => cellText(cell ?? {}));
    const labels = headers.length
      ? headers
      : values.map((_, valueIndex) => `Column ${valueIndex + 1}`);
    return {
      tableIndex,
      rowIndex: hasHeader ? index + 1 : index,
      text: formatRow(labels, values),
    };
  });
}

type TableCell = Record<string, unknown>;

function normalizeTableRows(
  tableRows: Record<string, unknown>[],
): Array<Array<TableCell | undefined>> {
  const grid: Array<Array<TableCell | undefined>> = [];

  for (let rowIndex = 0; rowIndex < tableRows.length; rowIndex += 1) {
    const row = tableRows[rowIndex];
    const cells = rowCells(row);
    grid[rowIndex] ??= [];
    let columnIndex = 0;

    for (const cell of cells) {
      while (grid[rowIndex][columnIndex]) columnIndex += 1;
      const attrs = isRecord(cell.attrs) ? cell.attrs : {};
      const rowspan = positiveSpan(attrs.rowspan);
      const colspan = positiveSpan(attrs.colspan);

      for (let rowOffset = 0; rowOffset < rowspan; rowOffset += 1) {
        const targetRow = rowIndex + rowOffset;
        grid[targetRow] ??= [];
        for (let columnOffset = 0; columnOffset < colspan; columnOffset += 1) {
          const targetColumn = columnIndex + columnOffset;
          grid[targetRow][targetColumn] ??= cell;
        }
      }
      columnIndex += colspan;
    }
  }

  const width = Math.max(0, ...grid.map((row) => row.length));
  return grid.slice(0, tableRows.length).map((row) =>
    Array.from({ length: width }, (_, index) => row[index]),
  );
}

function headerLabels(row: Array<TableCell | undefined>): string[] {
  return row.map(
    (cell, index) => cellText(cell ?? {}) || `Column ${index + 1}`,
  );
}

function positiveSpan(value: unknown): number {
  const span = Number(value);
  return Number.isInteger(span) && span > 0 ? span : 1;
}

function formatRow(labels: string[], values: string[]): string {
  const width = Math.max(labels.length, values.length);
  return Array.from({ length: width }, (_, index) => {
    const label = labels[index] || `Column ${index + 1}`;
    const value = values[index] ?? '';
    return `${escapeText(label)}=${escapeText(value)}`;
  }).join('; ');
}

function rowCells(row: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(row.content) ? row.content.filter(isRecord) : [];
}

function cellText(node: Record<string, unknown>): string {
  return collectText(node).replace(/\s+/g, ' ').trim();
}

function collectText(node: Record<string, unknown>): string {
  if (typeof node.text === 'string') return node.text;
  if (!Array.isArray(node.content)) return '';
  return node.content.filter(isRecord).map(collectText).join(' ');
}

function escapeText(value: string): string {
  return value.replace(/[;=]/g, (character) => `\\${character}`);
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void) {
  if (!isRecord(value)) return;
  visit(value);
  if (Array.isArray(value.content)) {
    for (const child of value.content) walk(child, visit);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
