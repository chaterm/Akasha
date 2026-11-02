import { Node } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { generateNodeId } from '../../utils';
import { addDatabaseDays, getDatabaseCellText } from './database-logic';
import {
  normalizeDatabaseCellValue,
  normalizeDatabaseColumns,
  normalizeDatabaseAlign,
  normalizeDatabaseRowOrder,
  normalizeDatabaseViews,
  type DatabaseCellValue,
  type DatabaseColumn,
  type DatabaseRowData,
  type DatabaseView,
} from './database-schema';

/**
 * Database block: one data source (columns + rows), many views.
 *
 *   database      attrs: id, title, columns, views, rowOrder
 *     databaseRow   attrs: id
 *       databaseCell  attrs: columnId, value
 *
 * Every cell is its own node so y-prosemirror merges concurrent edits per
 * cell; a row-level JSON attr would let one user's edit overwrite another's
 * in a different column. `columns`/`views`/`rowOrder` are JSON attrs on the
 * database node and are last-writer-wins as a whole.
 *
 * Views only store configuration (see database-schema.ts). Moving a card in
 * a kanban or calendar view writes the cell value; sorting never reorders
 * the document.
 */

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseJSON(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Reads rows in saved order, falling back to document order for unlisted rows
 * and old documents. If a column has duplicate cells (concurrent first writes),
 * the first wins. Deleted ids in the saved order are ignored.
 */
export function readDatabaseRows(node: PMNode): DatabaseRowData[] {
  const rows: DatabaseRowData[] = [];
  node.forEach((row) => {
    if (row.type.name !== 'databaseRow') return;
    const values: Record<string, DatabaseCellValue> = {};
    row.forEach((cell) => {
      const columnId = cell.attrs.columnId;
      if (typeof columnId === 'string' && !(columnId in values)) {
        values[columnId] = cell.attrs.value ?? null;
      }
    });
    rows.push({ id: String(row.attrs.id || ''), values });
  });
  const order = normalizeDatabaseRowOrder(node.attrs.rowOrder);
  const rank = new Map(order.map((id, index) => [id, index]));
  return rows.sort(
    (a, b) =>
      (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length),
  );
}

export function serializeDatabaseText(node: PMNode): string {
  const columns = normalizeDatabaseColumns(node.attrs.columns);
  const lines: string[] = [];
  const title = asString(node.attrs.title).trim();
  if (title) lines.push(title);
  lines.push(columns.map((column) => column.name).join(' | '));
  for (const row of readDatabaseRows(node)) {
    lines.push(
      columns
        .map((column) =>
          getDatabaseCellText(column, row.values[column.id] ?? null),
        )
        .join(' | '),
    );
  }
  return lines.join('\n');
}

export interface DatabaseRowInput {
  id?: string;
  values?: Record<string, DatabaseCellValue>;
}

export type DatabaseViewInput = Partial<DatabaseView> &
  Pick<DatabaseView, 'name' | 'type'>;

export interface DatabaseInput {
  id?: string;
  title?: string;
  columns: DatabaseColumn[];
  views: DatabaseViewInput[];
  rows?: DatabaseRowInput[];
}

export function buildDatabaseRowJSON(
  columns: DatabaseColumn[],
  row: DatabaseRowInput = {},
): JSONContent {
  const content = columns
    .filter((column) => row.values && column.id in row.values)
    .map((column) => ({
      type: 'databaseCell',
      attrs: {
        columnId: column.id,
        value: normalizeDatabaseCellValue(column.type, row.values![column.id]),
      },
    }));
  return {
    type: 'databaseRow',
    attrs: { id: row.id || generateNodeId() },
    ...(content.length ? { content } : {}),
  };
}

export function buildDatabaseJSON(input: DatabaseInput): JSONContent {
  const columns = normalizeDatabaseColumns(input.columns);
  const views = normalizeDatabaseViews(
    input.views.map((view) => ({ ...view, id: view.id || generateNodeId() })),
    columns,
  );
  const rows = (input.rows ?? []).map((row) =>
    buildDatabaseRowJSON(columns, row),
  );
  return {
    type: 'database',
    attrs: {
      id: input.id || generateNodeId(),
      title: input.title ?? '',
      columns,
      views,
    },
    ...(rows.length ? { content: rows } : {}),
  };
}

export interface DefaultDatabaseLabels {
  title: string;
  /** Name of the first column. */
  task: string;
  /** Title of the n-th sample row. */
  taskItem: (n: number) => string;
  member: string;
  /** Set on every sample row when known (the user inserting the database). */
  me?: { id: string; name: string; avatarUrl?: string };
  status: string;
  date: string;
  todo: string;
  doing: string;
  done: string;
  table: string;
  kanban: string;
  calendar: string;
  timeline: string;
  mine: string;
}

/**
 * Task + Member + Status + Date with table, kanban (by status), calendar,
 * timeline and "mine" views: three sample tasks, one per status,
 * assigned to `labels.me` and due a week after `today`.
 */
export function buildDefaultDatabaseJSON(
  labels: DefaultDatabaseLabels,
  today: Date = new Date(),
): JSONContent {
  const taskId = generateNodeId();
  const memberId = generateNodeId();
  const statusId = generateNodeId();
  const dateId = generateNodeId();
  const statuses = [
    { id: generateNodeId(), name: labels.todo, color: 'gray' as const },
    { id: generateNodeId(), name: labels.doing, color: 'blue' as const },
    { id: generateNodeId(), name: labels.done, color: 'green' as const },
  ];
  const columns: DatabaseColumn[] = [
    { id: taskId, name: labels.task, type: 'text' },
    {
      id: memberId,
      name: labels.member,
      type: 'person',
      options: labels.me ? [{ ...labels.me, color: 'blue' }] : [],
    },
    { id: statusId, name: labels.status, type: 'select', options: statuses },
    { id: dateId, name: labels.date, type: 'date' },
  ];
  const pad = (value: number) => String(value).padStart(2, '0');
  const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const due = addDatabaseDays(todayKey, 7);
  const views: DatabaseViewInput[] = [
    { name: labels.table, type: 'table' },
    { name: labels.kanban, type: 'kanban', groupBy: statusId },
    { name: labels.calendar, type: 'calendar', dateColumnId: dateId },
    { name: labels.timeline, type: 'timeline', dateColumnId: dateId },
    { name: labels.mine, type: 'mine' },
  ];
  return buildDatabaseJSON({
    title: labels.title,
    columns,
    views,
    rows: statuses.map((status, index) => ({
      values: {
        [taskId]: labels.taskItem(index + 1),
        [memberId]: labels.me ? [labels.me.id] : [],
        [statusId]: status.id,
        [dateId]: due,
      },
    })),
  });
}

function renderDatabaseDOM(node: PMNode): any {
  const columns = normalizeDatabaseColumns(node.attrs.columns);
  const views = normalizeDatabaseViews(node.attrs.views, columns);
  const title = asString(node.attrs.title);
  const header = [
    'tr',
    {},
    ...columns.map((column) => ['th', {}, column.name]),
  ];
  const body = readDatabaseRows(node).map((row) => [
    'tr',
    { 'data-row-id': row.id },
    ...columns.map((column) => {
      const value = row.values[column.id] ?? null;
      return [
        'td',
        column.id in row.values
          ? { 'data-column-id': column.id, 'data-value': JSON.stringify(value) }
          : {},
        getDatabaseCellText(column, value),
      ];
    }),
  ]);

  return [
    'div',
    {
      'data-type': 'database',
      'data-id': node.attrs.id || '',
      'data-title': title,
      'data-title-align': normalizeDatabaseAlign(node.attrs.titleAlign) ?? 'left',
      'data-columns': JSON.stringify(columns),
      'data-views': JSON.stringify(views),
      'data-row-order': JSON.stringify(
        normalizeDatabaseRowOrder(node.attrs.rowOrder),
      ),
    },
    ...(title ? [['p', { 'data-database-title': '' }, title]] : []),
    ['table', {}, ['thead', {}, header], ['tbody', {}, ...body]],
  ];
}

function parseDatabaseContent(dom: HTMLElement, schema: Schema): Fragment {
  const columns = normalizeDatabaseColumns(
    parseJSON(dom.getAttribute('data-columns')),
  );
  const types = new Map(columns.map((column) => [column.id, column.type]));
  const rows: PMNode[] = [];
  dom.querySelectorAll('tr[data-row-id]').forEach((tr) => {
    const cells: PMNode[] = [];
    tr.querySelectorAll('td[data-column-id]').forEach((td) => {
      const columnId = td.getAttribute('data-column-id')!;
      const type = types.get(columnId);
      if (!type) return;
      cells.push(
        schema.nodes.databaseCell.create({
          columnId,
          value: normalizeDatabaseCellValue(
            type,
            parseJSON(td.getAttribute('data-value')),
          ),
        }),
      );
    });
    rows.push(
      schema.nodes.databaseRow.create(
        { id: tr.getAttribute('data-row-id') || generateNodeId() },
        cells,
      ),
    );
  });
  return Fragment.from(rows);
}

export interface DatabaseOptions {
  HTMLAttributes: Record<string, any>;
  view: any;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    database: {
      insertDatabase: (content?: JSONContent) => ReturnType;
    };
  }
}

export const Database = Node.create<DatabaseOptions>({
  name: 'database',
  group: 'block',
  content: 'databaseRow*',
  // A black box for ProseMirror: the React view renders rows itself and
  // edits them through transactions in database-transforms.ts.
  atom: true,
  isolating: true,
  selectable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      view: null,
    };
  },

  addAttributes() {
    const columnsOf = (element: HTMLElement) =>
      normalizeDatabaseColumns(parseJSON(element.getAttribute('data-columns')));
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-id') || null,
        renderHTML: () => ({}),
      },
      title: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-title') || '',
        renderHTML: () => ({}),
      },
      titleAlign: {
        default: 'left',
        parseHTML: (element) =>
          normalizeDatabaseAlign(element.getAttribute('data-title-align')) ??
          'left',
        renderHTML: () => ({}),
      },
      rowOrder: {
        default: [],
        parseHTML: (element) =>
          normalizeDatabaseRowOrder(
            parseJSON(element.getAttribute('data-row-order')),
          ),
        renderHTML: () => ({}),
      },
      columns: {
        default: [],
        parseHTML: columnsOf,
        renderHTML: () => ({}),
      },
      views: {
        default: [],
        parseHTML: (element) =>
          normalizeDatabaseViews(
            parseJSON(element.getAttribute('data-views')),
            columnsOf(element),
          ),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="database"]',
        getContent: (dom, schema) =>
          parseDatabaseContent(dom as HTMLElement, schema),
      },
    ];
  },

  renderHTML({ node }) {
    return renderDatabaseDOM(node);
  },

  renderText({ node }) {
    return serializeDatabaseText(node);
  },

  addNodeView() {
    // Every event inside the view (inputs, keyboard, pointer drags) belongs
    // to React, never to ProseMirror.
    return ReactNodeViewRenderer(this.options.view, { stopEvent: () => true });
  },

  addCommands() {
    return {
      insertDatabase:
        (content) =>
        ({ commands }) =>
          commands.insertContent(
            content ??
              buildDatabaseJSON({
                columns: [],
                views: [{ name: 'Table', type: 'table' }],
              }),
          ),
    };
  },
});

// Rows and cells are only ever created by the database's own parse rule and
// transforms, so they have no parse rules of their own: a stray row pasted
// outside a database is dropped instead of being wrapped in an empty one.
export const DatabaseRow = Node.create({
  name: 'databaseRow',
  content: 'databaseCell*',

  addAttributes() {
    return {
      id: {
        default: null,
        renderHTML: (attributes) => ({ 'data-row-id': attributes.id }),
      },
    };
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', { 'data-type': this.name, ...HTMLAttributes }, 0];
  },
});

export const DatabaseCell = Node.create({
  name: 'databaseCell',
  atom: true,

  addAttributes() {
    return {
      columnId: {
        default: null,
        renderHTML: (attributes) => ({
          'data-column-id': attributes.columnId,
        }),
      },
      value: {
        default: null,
        renderHTML: (attributes) => ({
          'data-value': JSON.stringify(attributes.value ?? null),
        }),
      },
    };
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', { 'data-type': this.name, ...HTMLAttributes }];
  },
});
