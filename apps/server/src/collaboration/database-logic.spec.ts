import {
  DATABASE_EMPTY_GROUP,
  matchDatabaseSearch,
  formatDatabaseNumber,
  getDatabaseFilterDefaults,
  getDatabaseUrlHref,
  groupDatabaseRows,
  matchDatabaseFilter,
  nextDatabaseOptionColor,
  normalizeDatabaseFilter,
  parseDatabaseNumber,
  sortDatabaseRows,
  type DatabaseColumn,
  type DatabaseFilterGroup,
  type DatabaseRowData,
} from '@docmost/editor-ext';

const status: DatabaseColumn = {
  id: 'status',
  name: 'Status',
  type: 'select',
  options: [
    { id: 'todo', name: 'To do', color: 'gray' },
    { id: 'done', name: 'Done', color: 'green' },
  ],
};
const tags: DatabaseColumn = {
  id: 'tags',
  name: 'Tags',
  type: 'multiSelect',
  options: [
    { id: 'a', name: 'A', color: 'blue' },
    { id: 'b', name: 'B', color: 'red' },
  ],
};
const columns: DatabaseColumn[] = [
  { id: 'name', name: 'Name', type: 'text' },
  status,
  tags,
  { id: 'points', name: 'Points', type: 'number' },
  { id: 'due', name: 'Due', type: 'date' },
  { id: 'ok', name: 'OK', type: 'checkbox' },
];
const rows: DatabaseRowData[] = [
  {
    id: 'r1',
    values: {
      name: 'item 10',
      status: 'done',
      tags: ['a', 'b'],
      points: 3,
      due: '2026-11-03',
    },
  },
  { id: 'r2', values: { name: 'item 9', points: 1, ok: true } },
  {
    id: 'r3',
    values: { name: 'Item 2', status: 'todo', tags: ['b'], points: 3 },
  },
  { id: 'r4', values: { name: '', status: 'gone' } },
];
const ids = (list: DatabaseRowData[]) => list.map((row) => row.id);
const group = (
  conditions: any[],
  mode: 'and' | 'or' = 'and',
): DatabaseFilterGroup =>
  normalizeDatabaseFilter({ type: 'group', mode, conditions }, columns);

describe('sortDatabaseRows', () => {
  it('sorts by several columns, stable, with empty values last', () => {
    const sorted = sortDatabaseRows(rows, columns, [
      { columnId: 'points', direction: 'desc' },
      { columnId: 'name', direction: 'asc' },
    ]);
    expect(ids(sorted)).toEqual(['r3', 'r1', 'r2', 'r4']);
  });

  it('compares text naturally and select by option order', () => {
    expect(
      ids(
        sortDatabaseRows(rows, columns, [
          { columnId: 'name', direction: 'asc' },
        ]),
      ),
    ).toEqual(['r3', 'r2', 'r1', 'r4']);
    // r4 points at a deleted option and sorts as empty.
    expect(
      ids(
        sortDatabaseRows(rows, columns, [
          { columnId: 'status', direction: 'asc' },
        ]),
      ),
    ).toEqual(['r3', 'r1', 'r2', 'r4']);
  });
});

describe('matchDatabaseFilter', () => {
  const match = (filter: DatabaseFilterGroup) =>
    ids(rows.filter((row) => matchDatabaseFilter(filter, columns, row)));

  it('evaluates operators per type', () => {
    expect(
      match(
        group([
          {
            type: 'condition',
            columnId: 'name',
            op: 'contains',
            value: 'ITEM',
          },
        ]),
      ),
    ).toEqual(['r1', 'r2', 'r3']);
    expect(
      match(
        group([{ type: 'condition', columnId: 'points', op: 'gte', value: 3 }]),
      ),
    ).toEqual(['r1', 'r3']);
    expect(
      match(
        group([
          {
            type: 'condition',
            columnId: 'tags',
            op: 'hasAllOf',
            value: ['a', 'b'],
          },
        ]),
      ),
    ).toEqual(['r1']);
    expect(
      match(
        group([
          {
            type: 'condition',
            columnId: 'status',
            op: 'isNoneOf',
            value: ['done'],
          },
        ]),
      ),
    ).toEqual(['r2', 'r3', 'r4']);
    expect(
      match(
        group([
          { type: 'condition', columnId: 'ok', op: 'isChecked', value: null },
        ]),
      ),
    ).toEqual(['r2']);
    expect(
      match(
        group([
          {
            type: 'condition',
            columnId: 'due',
            op: 'before',
            value: '2026-12-01',
          },
        ]),
      ),
    ).toEqual(['r1']);
  });

  it('treats a value pointing at a deleted option as empty', () => {
    expect(
      match(
        group([
          { type: 'condition', columnId: 'status', op: 'isEmpty', value: null },
        ]),
      ),
    ).toEqual(['r2', 'r4']);
  });

  it('combines and/or with nested groups and ignores incomplete conditions', () => {
    const filter = group(
      [
        { type: 'condition', columnId: 'ok', op: 'isChecked', value: null },
        {
          type: 'group',
          mode: 'and',
          conditions: [
            { type: 'condition', columnId: 'points', op: 'eq', value: 3 },
            {
              type: 'condition',
              columnId: 'status',
              op: 'isAnyOf',
              value: ['todo'],
            },
            { type: 'condition', columnId: 'name', op: 'contains', value: '' },
          ],
        },
      ],
      'or',
    );
    expect(match(filter)).toEqual(['r2', 'r3']);
  });

  it('drops conditions with unknown columns or unsupported operators', () => {
    const filter = group([
      { type: 'condition', columnId: 'gone', op: 'isEmpty', value: null },
      { type: 'condition', columnId: 'points', op: 'contains', value: 'x' },
      { type: 'condition', columnId: 'points', op: 'gt', value: '2' },
    ]);
    expect(filter.conditions).toEqual([
      { type: 'condition', columnId: 'points', op: 'gt', value: 2 },
    ]);
  });

  it('derives values for rows created in a filtered view', () => {
    const filter = group([
      { type: 'condition', columnId: 'status', op: 'isAnyOf', value: ['todo'] },
      { type: 'condition', columnId: 'points', op: 'gt', value: 5 },
      { type: 'condition', columnId: 'ok', op: 'isChecked', value: null },
    ]);
    expect(getDatabaseFilterDefaults(filter, columns)).toEqual({
      status: 'todo',
      points: 6,
      ok: true,
    });
  });
});

describe('groupDatabaseRows', () => {
  const view = {
    groupOrder: [] as string[],
    cardOrder: {} as Record<string, string[]>,
    sorts: [],
  };

  it('puts multiSelect rows in every group they have, stale values in the trailing empty group', () => {
    const groups = groupDatabaseRows(rows, tags, view);
    expect(groups.map((g) => [g.key, ids(g.rows)])).toEqual([
      ['a', ['r1']],
      ['b', ['r1', 'r3']],
      [DATABASE_EMPTY_GROUP, ['r2', 'r4']],
    ]);
  });

  it('applies group order and manual card order, unless the view is sorted', () => {
    const ordered = { ...view, groupOrder: ['b'], cardOrder: { b: ['r3'] } };
    const groups = groupDatabaseRows(rows, tags, ordered);
    expect(groups.map((g) => g.key)).toEqual(['b', 'a', DATABASE_EMPTY_GROUP]);
    expect(ids(groups[0].rows)).toEqual(['r3', 'r1']);
    const sorted = groupDatabaseRows(rows, tags, {
      ...ordered,
      sorts: [{ columnId: 'name', direction: 'asc' }] as any,
    });
    expect(ids(sorted[0].rows)).toEqual(['r1', 'r3']);
  });
});

describe('formatting helpers', () => {
  it('formats and parses numbers', () => {
    expect(
      formatDatabaseNumber(1234.5, { format: 'commas', decimals: 2 }, 'en-US'),
    ).toBe('1,234.50');
    expect(
      formatDatabaseNumber(12, { format: 'percent', decimals: null }, 'en-US'),
    ).toBe('12%');
    expect(
      formatDatabaseNumber(5, { format: 'USD', decimals: null }, 'en-US'),
    ).toBe('$5.00');
    expect(parseDatabaseNumber('$1,234.5', 'en-US')).toBe(1234.5);
    expect(parseDatabaseNumber('1.234,5', 'de-DE')).toBe(1234.5);
    expect(parseDatabaseNumber('45%', 'en-US')).toBe(45);
    expect(parseDatabaseNumber('abc', 'en-US')).toBeNull();
  });

  it('only links http(s)/mailto urls', () => {
    expect(getDatabaseUrlHref('example.com/a')).toBe('https://example.com/a');
    expect(getDatabaseUrlHref('https://x.io')).toBe('https://x.io/');
    expect(getDatabaseUrlHref('javascript:alert(1)')).toBeNull();
    expect(getDatabaseUrlHref('not a link')).toBeNull();
  });

  it('picks the least used option color', () => {
    expect(nextDatabaseOptionColor([])).toBe('blue');
    expect(
      nextDatabaseOptionColor([{ id: '1', name: '', color: 'blue' }]),
    ).toBe('green');
  });
});

describe('person columns', () => {
  const owner = {
    id: 'owner',
    name: 'Owner',
    type: 'person' as const,
    options: [
      { id: 'u1', name: 'Ann', color: 'blue' as const },
      { id: 'u2', name: 'Bob', color: 'blue' as const },
      // Once assigned, then removed from every row.
      { id: 'u3', name: 'Cid', color: 'blue' as const },
    ],
  };
  const people = [
    { id: 'r1', values: { owner: ['u2'] } },
    { id: 'r2', values: { owner: ['u1', 'u2'] } },
    { id: 'r3', values: {} },
  ];

  it('groups by member in option order, unassigned last; unused members get no group', () => {
    const groups = groupDatabaseRows(people, owner, {
      groupOrder: [],
      cardOrder: {},
      sorts: [],
    });
    expect(groups.map((g) => [g.key, ids(g.rows)])).toEqual([
      ['u1', ['r2']],
      ['u2', ['r1', 'r2']],
      [DATABASE_EMPTY_GROUP, ['r3']],
    ]);
  });

  it('shows and searches member names', () => {
    expect(matchDatabaseSearch('bob', [owner], people[0])).toBe(true);
    expect(matchDatabaseSearch('u2', [owner], people[0])).toBe(false);
  });
});
