import { getSchema } from '@tiptap/core';
import { Node } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import {
  addDatabaseColumn,
  addDatabaseView,
  buildDatabaseJSON,
  buildDefaultDatabaseJSON,
  changeDatabaseColumnType,
  deleteDatabaseRow,
  deleteDatabaseColumn,
  duplicateDatabaseColumn,
  insertDatabaseRow,
  moveDatabaseCard,
  moveDatabaseRow,
  moveDatabaseRowToDate,
  moveDatabaseView,
  normalizeDatabaseColumns,
  normalizeDatabaseViews,
  readDatabaseRows,
  resizeDatabaseRowRange,
  setDatabaseCellValue,
  setDatabaseTitleAlign,
  updateDatabaseView,
  type DatabaseColumn,
} from '@docmost/editor-ext';
import {
  htmlToJson,
  jsonToHtml,
  jsonToText,
  tiptapExtensions,
} from './collaboration.util';

const columns: DatabaseColumn[] = [
  { id: 'name', name: 'Name', type: 'text' },
  {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'todo', name: 'To do', color: 'gray' },
      { id: 'done', name: 'Done', color: 'green' },
    ],
  },
  {
    id: 'tags',
    name: 'Tags',
    type: 'multiSelect',
    options: [
      { id: 'a', name: 'A', color: 'blue' },
      { id: 'b', name: 'B', color: 'red' },
    ],
  },
  { id: 'due', name: 'Due', type: 'date' },
  { id: 'end', name: 'End', type: 'date' },
  {
    id: 'points',
    name: 'Points',
    type: 'number',
    format: 'commas',
    decimals: 1,
  },
];

function makeDoc() {
  const database = buildDatabaseJSON({
    id: 'db1',
    title: 'Tasks',
    columns,
    views: [
      { id: 'v1', name: 'Table', type: 'table' },
      { id: 'v2', name: 'Board', type: 'kanban', groupBy: 'status' },
      {
        id: 'v3',
        name: 'Cal',
        type: 'calendar',
        dateColumnId: 'due',
        endDateColumnId: 'end',
      },
      { id: 'v4', name: 'Tags', type: 'kanban', groupBy: 'tags' },
    ],
    rows: [
      {
        id: 'r1',
        values: {
          name: 'Write spec',
          status: 'todo',
          tags: ['a', 'b'],
          due: '2026-11-03',
          end: '2026-11-05',
          points: 1234.5,
        },
      },
      { id: 'r2', values: { name: 'Ship it', status: 'done' } },
      { id: 'r3', values: { name: 'Review', points: 3 } },
    ],
  });
  return { type: 'doc', content: [database] };
}

function makeState() {
  const schema = getSchema(tiptapExtensions);
  return EditorState.create({ doc: Node.fromJSON(schema, makeDoc()) });
}

const db = (tr: { doc: Node }) => tr.doc.child(0);
const rowsOf = (tr: { doc: Node }) => readDatabaseRows(db(tr));
const viewOf = (tr: { doc: Node }, id: string) =>
  db(tr).attrs.views.find((view: any) => view.id === id);

describe('database node', () => {
  it('round-trips through HTML with columns, views and cell values', () => {
    const html = jsonToHtml(makeDoc());
    expect(html).toContain(
      '<td data-column-id="status" data-value="&quot;todo&quot;">To do</td>',
    );

    const json = htmlToJson(html);
    const database = json.content.find((node: any) => node.type === 'database');
    expect(database.attrs.id).toBe('db1');
    expect(database.attrs.columns.map((c: any) => c.id)).toEqual(
      columns.map((c) => c.id),
    );
    expect(database.attrs.views[2].endDateColumnId).toBe('end');

    const schema = getSchema(tiptapExtensions);
    const rows = readDatabaseRows(Node.fromJSON(schema, database));
    expect(rows.map((row) => row.id)).toEqual(['r1', 'r2', 'r3']);
    expect(rows[0].values.tags).toEqual(['a', 'b']);
  });

  it('serializes readable text for search, resolving options and number format', () => {
    const text = jsonToText(makeDoc());
    expect(text).toContain('Name | Status | Tags | Due | End | Points');
    expect(text).toContain(
      'Write spec | To do | A, B | 2026-11-03 | 2026-11-05 | 1,234.5',
    );
  });

  it('preserves manual row order through JSON, HTML and text export', () => {
    const tr = makeState().tr;
    moveDatabaseRow(tr, 0, 'r3', 'r1');
    const json = tr.doc.toJSON();
    expect(
      rowsOf({ doc: Node.fromJSON(tr.doc.type.schema, json) }).map(
        (row) => row.id,
      ),
    ).toEqual(['r3', 'r1', 'r2']);
    const html = jsonToHtml(json);
    const parsed = Node.fromJSON(tr.doc.type.schema, htmlToJson(html));
    expect(rowsOf({ doc: parsed }).map((row) => row.id)).toEqual([
      'r3',
      'r1',
      'r2',
    ]);
    const text = jsonToText(json);
    expect(text.indexOf('Review')).toBeLessThan(text.indexOf('Write spec'));
  });

  it('migrates v1 views: hiddenColumnIds and single sort', () => {
    const [view] = normalizeDatabaseViews(
      [
        {
          id: 'v',
          name: 'x',
          type: 'table',
          hiddenColumnIds: ['due'],
          sort: { columnId: 'points', direction: 'desc' },
        },
      ],
      columns,
    );
    expect(view.columns.find((entry) => entry.id === 'due')!.hidden).toBe(true);
    expect(view.sorts).toEqual([{ columnId: 'points', direction: 'desc' }]);
  });

  it('keeps the saved column order and visibility, and appends new columns', () => {
    const [view] = normalizeDatabaseViews(
      [
        {
          id: 'v',
          name: 'x',
          type: 'table',
          columns: [{ id: 'status' }, { id: 'due', hidden: true }],
        },
      ],
      columns,
    );
    expect(view.columns.map((entry) => entry.id)).toEqual([
      'name',
      'status',
      'due',
      'tags',
      'end',
      'points',
    ]);
    expect(view.columns[2].hidden).toBe(true);
    expect(view.showRowNumbers).toBe(true);
  });

  it('keeps the title column first and shown in every view', () => {
    const [view] = normalizeDatabaseViews(
      [
        {
          id: 'v',
          name: 'x',
          type: 'table',
          columns: [{ id: 'due' }, { id: 'name', hidden: true }],
        },
      ],
      columns,
    );
    expect(view.columns[0]).toMatchObject({ id: 'name', hidden: false });
    expect(view.columns[1].id).toBe('due');
  });

  it('reads an old title column as text', () => {
    const [column] = normalizeDatabaseColumns([
      { id: 'name', name: 'Name', type: 'title' },
    ]);
    expect(column.type).toBe('text');
  });

  it('kanban and calendar fall back to the first usable column', () => {
    const views = normalizeDatabaseViews(
      [
        { id: 'k', name: 'k', type: 'kanban', groupBy: 'due' },
        { id: 'c', name: 'c', type: 'calendar', endDateColumnId: 'due' },
      ],
      columns,
    );
    expect(views[0].groupBy).toBe('status');
    expect(views[1].dateColumnId).toBe('due');
    expect(views[1].endDateColumnId).toBeNull();
  });
});

describe('database row and column transforms', () => {
  it('updates an existing cell in place and creates a missing one', () => {
    const tr = makeState().tr;
    setDatabaseCellValue(tr, 0, 'r1', 'status', 'done');
    setDatabaseCellValue(tr, 0, 'r3', 'status', 'todo');
    expect(rowsOf(tr)[0].values.status).toBe('done');
    expect(rowsOf(tr)[2].values.status).toBe('todo');
  });

  it('inserts before/after and moves rows by id', () => {
    const tr = makeState().tr;
    insertDatabaseRow(tr, 0, { id: 'r0', beforeRowId: 'r1' });
    insertDatabaseRow(tr, 0, { id: 'r1b', afterRowId: 'r1' });
    insertDatabaseRow(tr, 0, { id: 'r4' });
    expect(rowsOf(tr).map((row) => row.id)).toEqual([
      'r0',
      'r1',
      'r1b',
      'r2',
      'r3',
      'r4',
    ]);
    moveDatabaseRow(tr, 0, 'r4', 'r1');
    moveDatabaseRow(tr, 0, 'r0', null);
    expect(rowsOf(tr).map((row) => row.id)).toEqual([
      'r4',
      'r1',
      'r1b',
      'r2',
      'r3',
      'r0',
    ]);
  });

  it('inserts and deletes relative to the saved order after moving rows', () => {
    const tr = makeState().tr;
    moveDatabaseRow(tr, 0, 'r3', 'r1');
    insertDatabaseRow(tr, 0, { id: 'new', afterRowId: 'r3' });
    deleteDatabaseRow(tr, 0, 'r1');
    insertDatabaseRow(tr, 0, { id: 'last' });
    expect(rowsOf(tr).map((row) => row.id)).toEqual([
      'r3',
      'new',
      'r2',
      'last',
    ]);
  });

  it('adds a column next to an anchor in every view', () => {
    const tr = makeState().tr;
    const id = addDatabaseColumn(
      tr,
      0,
      { name: 'Note', type: 'text' },
      { anchorId: 'status', side: 'left' },
    );
    expect(
      viewOf(tr, 'v1')
        .columns.map((entry: any) => entry.id)
        .slice(0, 3),
    ).toEqual(['name', id, 'status']);
    // Nothing goes before the title column.
    const first = addDatabaseColumn(
      tr,
      0,
      { name: 'X', type: 'text' },
      { anchorId: 'name', side: 'left' },
    );
    const ids = viewOf(tr, 'v1').columns.map((entry: any) => entry.id);
    expect(ids.slice(0, 2)).toEqual(['name', first]);
  });

  it('never deletes the title column or changes its type', () => {
    const tr = makeState().tr;
    deleteDatabaseColumn(tr, 0, 'name');
    changeDatabaseColumnType(tr, 0, 'name', 'number');
    const db = tr.doc.child(0);
    expect(db.attrs.columns[0]).toMatchObject({ id: 'name', type: 'text' });
  });

  it('duplicates a column with its values', () => {
    const tr = makeState().tr;
    const id = duplicateDatabaseColumn(tr, 0, 'tags', 'Tags copy')!;
    expect(rowsOf(tr)[0].values[id]).toEqual(['a', 'b']);
    const ids = viewOf(tr, 'v1').columns.map((entry: any) => entry.id);
    expect(ids[ids.indexOf('tags') + 1]).toBe(id);
  });

  it('converts text to select, creating options from comma separated values', () => {
    const tr = makeState().tr;
    const note = addDatabaseColumn(tr, 0, { name: 'Note', type: 'text' });
    setDatabaseCellValue(tr, 0, 'r1', note, 'red, Blue');
    setDatabaseCellValue(tr, 0, 'r2', note, 'blue');
    changeDatabaseColumnType(tr, 0, note, 'multiSelect');
    const column = db(tr).attrs.columns.find((c: any) => c.id === note);
    expect(column.options.map((o: any) => o.name)).toEqual(['red', 'Blue']);
    const [red, blue] = column.options.map((o: any) => o.id);
    expect(rowsOf(tr)[0].values[note]).toEqual([red, blue]);
    expect(rowsOf(tr)[1].values[note]).toEqual([blue]);
  });

  it('converts multiSelect to select keeping the first value, and select to text by name', () => {
    const tr = makeState().tr;
    changeDatabaseColumnType(tr, 0, 'tags', 'select');
    expect(rowsOf(tr)[0].values.tags).toBe('a');
    changeDatabaseColumnType(tr, 0, 'status', 'text');
    expect(rowsOf(tr)[0].values.status).toBe('To do');
    // The board grouped by status falls back to the next groupable column.
    expect(viewOf(tr, 'v2').groupBy).toBe('tags');
  });

  it('converts number to text without formatting, and text back to number', () => {
    const tr = makeState().tr;
    changeDatabaseColumnType(tr, 0, 'points', 'text');
    expect(rowsOf(tr)[0].values.points).toBe('1234.5');
    changeDatabaseColumnType(tr, 0, 'points', 'number');
    expect(rowsOf(tr)[0].values.points).toBe(1234.5);
  });

  it('deleting a column removes its cells and view references; the last column stays', () => {
    const tr = makeState().tr;
    updateDatabaseView(tr, 0, 'v1', {
      sorts: [{ columnId: 'due', direction: 'asc' }],
    });
    deleteDatabaseColumn(tr, 0, 'due');
    expect(rowsOf(tr)[0].values).not.toHaveProperty('due');
    expect(viewOf(tr, 'v1').sorts).toEqual([]);
    expect(viewOf(tr, 'v3').dateColumnId).toBe('end');

    const last = makeState().tr;
    for (const id of ['status', 'tags', 'due', 'end', 'points'])
      deleteDatabaseColumn(last, 0, id);
    deleteDatabaseColumn(last, 0, 'name');
    expect(db(last).attrs.columns.map((c: any) => c.id)).toEqual(['name']);
  });
});

describe('database view transforms', () => {
  it('moves a view before another or to the end', () => {
    const tr = makeState().tr;
    const order = () => db(tr).attrs.views.map((view: any) => view.id);
    moveDatabaseView(tr, 0, 'v3', 'v1');
    expect(order()).toEqual(['v3', 'v1', 'v2', 'v4']);
    moveDatabaseView(tr, 0, 'v3', null);
    expect(order()).toEqual(['v1', 'v2', 'v4', 'v3']);
  });

  it('keeps title and column alignment', () => {
    const tr = makeState().tr;
    setDatabaseTitleAlign(tr, 0, 'center');
    expect(db(tr).attrs.titleAlign).toBe('center');
    updateDatabaseView(tr, 0, 'v1', {
      columns: viewOf(tr, 'v1').columns.map((entry) =>
        entry.id === 'points' ? { ...entry, align: 'right' } : entry,
      ),
    });
    const points = viewOf(tr, 'v1').columns.find((e) => e.id === 'points');
    expect(points?.align).toBe('right');
  });

  it('changing groupBy resets the group layout', () => {
    const tr = makeState().tr;
    updateDatabaseView(tr, 0, 'v2', {
      hiddenGroups: ['todo'],
      cardOrder: { todo: ['r1'] },
    });
    updateDatabaseView(tr, 0, 'v2', { groupBy: 'tags' });
    expect(viewOf(tr, 'v2').hiddenGroups).toEqual([]);
    expect(viewOf(tr, 'v2').cardOrder).toEqual({});
  });

  it('moving a card between select groups writes the value and the card order', () => {
    const tr = makeState().tr;
    moveDatabaseCard(tr, 0, 'v2', {
      rowId: 'r1',
      fromKey: 'todo',
      toKey: 'done',
      beforeRowId: 'r2',
    });
    expect(rowsOf(tr)[0].values.status).toBe('done');
    expect(viewOf(tr, 'v2').cardOrder.done).toEqual(['r1', 'r2']);
    // Document order is untouched: the table view is not affected.
    expect(rowsOf(tr).map((row) => row.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('moving a multiSelect card only swaps the source tag', () => {
    const tr = makeState().tr;
    setDatabaseCellValue(tr, 0, 'r2', 'tags', ['b']);
    moveDatabaseCard(tr, 0, 'v4', {
      rowId: 'r2',
      fromKey: 'b',
      toKey: 'a',
      beforeRowId: null,
    });
    expect(rowsOf(tr)[1].values.tags).toEqual(['a']);
    moveDatabaseCard(tr, 0, 'v4', {
      rowId: 'r1',
      fromKey: 'b',
      toKey: 'a',
      beforeRowId: null,
    });
    expect(rowsOf(tr)[0].values.tags).toEqual(['a']);
  });

  it('moving a calendar row keeps its duration; resizing never crosses the other edge', () => {
    const tr = makeState().tr;
    moveDatabaseRowToDate(tr, 0, 'v3', 'r1', '2026-11-30');
    expect(rowsOf(tr)[0].values).toMatchObject({
      due: '2026-11-30',
      end: '2026-12-02',
    });
    resizeDatabaseRowRange(tr, 0, 'v3', 'r1', 'end', '2026-11-01');
    expect(rowsOf(tr)[0].values.end).toBe('2026-11-30');
    resizeDatabaseRowRange(tr, 0, 'v3', 'r1', 'start', '2026-11-28');
    expect(rowsOf(tr)[0].values.due).toBe('2026-11-28');
  });

  it.each(['2026-11-01', '2026-11-10'])(
    'moving a one-day range to %s moves both endpoints',
    (date) => {
      const tr = makeState().tr;
      setDatabaseCellValue(tr, 0, 'r1', 'end', '2026-11-03');
      moveDatabaseRowToDate(tr, 0, 'v3', 'r1', date);
      expect(rowsOf(tr)[0].values).toMatchObject({ due: date, end: date });
    },
  );

  it('moving a row with no end date leaves the end date empty', () => {
    const tr = makeState().tr;
    setDatabaseCellValue(tr, 0, 'r1', 'end', null);
    moveDatabaseRowToDate(tr, 0, 'v3', 'r1', '2026-11-01');
    expect(rowsOf(tr)[0].values).toMatchObject({
      due: '2026-11-01',
      end: null,
    });
  });
});

describe('default database', () => {
  it('has three tasks, one per status, due a week after today', () => {
    const json = buildDefaultDatabaseJSON(
      {
        title: '',
        task: 'Task',
        taskItem: (n) => `Task ${n}`,
        member: 'Member',
        me: { id: 'u1', name: 'Ann' },
        status: 'Status',
        date: 'Date',
        todo: 'To do',
        doing: 'In progress',
        done: 'Done',
        table: 'Table',
        kanban: 'Kanban',
        calendar: 'Calendar',
        timeline: 'Timeline',
        mine: 'Mine',
      },
      new Date(2026, 11, 28),
    );
    const schema = getSchema(tiptapExtensions);
    const node = Node.fromJSON(schema, json);
    const [task, member, status, date] = node.attrs.columns;
    const rows = readDatabaseRows(node);
    expect(member.type).toBe('person');
    expect(member.options).toEqual([{ id: 'u1', name: 'Ann', color: 'blue' }]);
    expect(rows.map((row) => row.values[member.id])).toEqual([
      ['u1'],
      ['u1'],
      ['u1'],
    ]);
    const kanban = node.attrs.views.find((view: any) => view.type === 'kanban');
    expect(kanban.groupBy).toBe(status.id);
    expect(kanban.orientation).toBe('vertical');
    const timeline = node.attrs.views.find((view: any) => view.type === 'timeline');
    expect(timeline.dateColumnId).toBe(date.id);
    expect(node.attrs.views.map((view: any) => view.type)).toContain('mine');
    expect(rows.map((row) => row.values[task.id])).toEqual([
      'Task 1',
      'Task 2',
      'Task 3',
    ]);
    expect(rows.map((row) => row.values[status.id])).toEqual(
      status.options.map((option: any) => option.id),
    );
    expect(rows.map((row) => row.values[date.id])).toEqual([
      '2027-01-04',
      '2027-01-04',
      '2027-01-04',
    ]);
  });
});

describe('document columns', () => {
  it('store only page ids, so no title reaches the document or its search text', () => {
    // Index 0 is the title column added for a database without text columns.
    const [, doc] = normalizeDatabaseColumns([
      {
        id: 'doc',
        name: 'Doc',
        type: 'page',
        options: [
          { id: 'p1', name: 'Layoff list', color: 'blue', slugId: 'x', unavailable: true },
        ],
      },
    ]);
    expect(doc.options).toEqual([{ id: 'p1', name: '', color: 'blue' }]);

    const json = jsonToText({
      type: 'doc',
      content: [
        buildDatabaseJSON({
          columns: [doc],
          views: [{ name: 'T', type: 'table' }],
          rows: [{ values: { doc: ['p1'] } }],
        }),
      ],
    });
    expect(json).not.toContain('Layoff list');
  });
});
