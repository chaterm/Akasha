import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import { buildDatabaseJSON } from '@docmost/editor-ext';
import { tiptapExtensions } from '../collaboration.util';
import { applyPageEdits } from './page-edit';
import type { PageEditOp } from './page-edit.types';

const schema = getSchema(tiptapExtensions);

const docOf = (content: JSONContent[]) =>
  PMNode.fromJSON(schema, { type: 'doc', content });

const paragraph = (text: string, id?: string): JSONContent => ({
  type: 'paragraph',
  ...(id ? { attrs: { id } } : {}),
  content: [{ type: 'text', text }],
});

const cell = (text: string) => ({
  type: 'tableCell',
  attrs: { colspan: 1, rowspan: 1, colwidth: null },
  content: [paragraph(text)],
});

const table = (id: string, rows: string[][]): JSONContent => ({
  type: 'table',
  attrs: { id },
  content: rows.map((cells) => ({
    type: 'tableRow',
    content: cells.map(cell),
  })),
});

const run = (content: JSONContent[], ops: PageEditOp[]) =>
  applyPageEdits(docOf(content), ops);

describe('applyPageEdits generic ops', () => {
  it('replaces one node and leaves its siblings untouched', () => {
    const { doc } = run(
      [paragraph('一', 'a'), paragraph('二', 'b'), paragraph('三', 'c')],
      [{ type: 'replace_node', nodeId: 'b', content: paragraph('改过', 'b') }],
    );
    expect(doc.content.childCount).toBe(3);
    expect(doc.child(0).textContent).toBe('一');
    expect(doc.child(1).textContent).toBe('改过');
    expect(doc.child(2).textContent).toBe('三');
  });

  it('updates attrs without touching content', () => {
    const { doc } = run(
      [
        {
          type: 'taskList',
          attrs: { id: 'list' },
          content: [
            {
              type: 'taskItem',
              attrs: { id: 'item', checked: false },
              content: [paragraph('待办')],
            },
          ],
        },
      ],
      [{ type: 'update_node_attrs', nodeId: 'item', attrs: { checked: true } }],
    );
    const item = doc.child(0).child(0);
    expect(item.attrs.checked).toBe(true);
    expect(item.textContent).toBe('待办');
  });

  it('inserts before and after a node', () => {
    const { doc } = run(
      [paragraph('中', 'mid')],
      [
        { type: 'insert_before', nodeId: 'mid', content: [paragraph('前')] },
        { type: 'insert_after', nodeId: 'mid', content: [paragraph('后')] },
      ],
    );
    expect(
      doc.content.content.map((node: PMNode) => node.textContent),
    ).toEqual(['前', '中', '后']);
  });

  it('deletes a node', () => {
    const { doc } = run(
      [paragraph('留', 'keep'), paragraph('删', 'drop')],
      [{ type: 'delete_node', nodeId: 'drop' }],
    );
    expect(doc.content.childCount).toBe(1);
    expect(doc.child(0).textContent).toBe('留');
  });

  it('reports NOT_FOUND for an unknown id', () => {
    expect(() =>
      run([paragraph('x', 'a')], [{ type: 'delete_node', nodeId: 'missing' }]),
    ).toThrow(NotFoundException);
  });

  it('rejects an attribute the node type does not declare', () => {
    expect(() =>
      run(
        [paragraph('x', 'a')],
        [{ type: 'update_node_attrs', nodeId: 'a', attrs: { bogus: 1 } }],
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects an unknown node type in replacement content', () => {
    expect(() =>
      run(
        [paragraph('x', 'a')],
        [
          {
            type: 'replace_node',
            nodeId: 'a',
            content: { type: 'callOut', content: [paragraph('typo')] },
          },
        ],
      ),
    ).toThrow(BadRequestException);
  });

  it('applies several ops in one call, in order', () => {
    const { doc, outcomes } = run(
      [paragraph('一', 'a'), paragraph('二', 'b')],
      [
        { type: 'replace_node', nodeId: 'a', content: paragraph('A', 'a') },
        { type: 'replace_node', nodeId: 'b', content: paragraph('B', 'b') },
      ],
    );
    expect(outcomes).toHaveLength(2);
    expect(
      doc.content.content.map((node: PMNode) => node.textContent),
    ).toEqual(['A', 'B']);
  });

  it('rejects more ops than the per-call limit', () => {
    const ops = Array.from({ length: 51 }, () => ({
      type: 'delete_node' as const,
      nodeId: 'a',
    }));
    expect(() => run([paragraph('x', 'a')], ops)).toThrow(BadRequestException);
  });
});

describe('applyPageEdits expect guard', () => {
  it('passes when the expectation matches', () => {
    const { doc } = run(
      [paragraph('联调中', 'a')],
      [
        {
          type: 'replace_node',
          nodeId: 'a',
          content: paragraph('已完成', 'a'),
          expect: { textContent: '联调中' },
        },
      ],
    );
    expect(doc.child(0).textContent).toBe('已完成');
  });

  it('refuses the whole call when the text changed underneath', () => {
    expect(() =>
      run(
        [paragraph('别人改过了', 'a')],
        [
          {
            type: 'replace_node',
            nodeId: 'a',
            content: paragraph('新', 'a'),
            expect: { textContent: '联调中' },
          },
        ],
      ),
    ).toThrow(BadRequestException);
  });

  it('refuses on an attrs mismatch', () => {
    expect(() =>
      run(
        [
          {
            type: 'taskList',
            attrs: { id: 'l' },
            content: [
              {
                type: 'taskItem',
                attrs: { id: 'i', checked: true },
                content: [paragraph('done')],
              },
            ],
          },
        ],
        [
          {
            type: 'update_node_attrs',
            nodeId: 'i',
            attrs: { checked: true },
            expect: { attrs: { checked: false } },
          },
        ],
      ),
    ).toThrow(BadRequestException);
  });

  it('leaves the document unchanged when a later op conflicts', () => {
    const content = [paragraph('一', 'a'), paragraph('二', 'b')];
    const before = JSON.stringify(docOf(content).toJSON());
    expect(() =>
      run(content, [
        { type: 'replace_node', nodeId: 'a', content: paragraph('A', 'a') },
        {
          type: 'replace_node',
          nodeId: 'b',
          content: paragraph('B', 'b'),
          expect: { textContent: '不匹配' },
        },
      ]),
    ).toThrow(BadRequestException);
    expect(JSON.stringify(docOf(content).toJSON())).toBe(before);
  });
});

describe('applyPageEdits table ops', () => {
  const grid = () =>
    table('t', [
      ['事项', '状态'],
      ['A', '进行中'],
    ]);

  it('sets one cell by coordinates', () => {
    const { doc } = run(
      [grid()],
      [
        {
          type: 'set_table_cell',
          tableId: 't',
          row: 1,
          col: 1,
          content: [paragraph('已完成')],
        },
      ],
    );
    const tableNode = doc.child(0);
    expect(tableNode.child(1).child(1).textContent).toBe('已完成');
    expect(tableNode.child(1).child(0).textContent).toBe('A');
    expect(tableNode.child(0).child(0).textContent).toBe('事项');
  });

  it('rejects out-of-range coordinates', () => {
    expect(() =>
      run(
        [grid()],
        [
          {
            type: 'set_table_cell',
            tableId: 't',
            row: 5,
            col: 0,
            content: [paragraph('x')],
          },
        ],
      ),
    ).toThrow(BadRequestException);
  });

  it('honours the cell expectation', () => {
    expect(() =>
      run(
        [grid()],
        [
          {
            type: 'set_table_cell',
            tableId: 't',
            row: 1,
            col: 1,
            content: [paragraph('已完成')],
            expect: { textContent: '别的内容' },
          },
        ],
      ),
    ).toThrow(BadRequestException);
  });

  it('inserts a row at an index and keeps the column count', () => {
    const { doc } = run(
      [grid()],
      [
        {
          type: 'insert_table_row',
          tableId: 't',
          at: 1,
          cells: [[paragraph('B')], [paragraph('待确认')]],
        },
      ],
    );
    const tableNode = doc.child(0);
    expect(tableNode.childCount).toBe(3);
    expect(tableNode.child(1).child(0).textContent).toBe('B');
    expect(tableNode.child(1).child(1).textContent).toBe('待确认');
    expect(tableNode.child(2).child(0).textContent).toBe('A');
    tableNode.forEach((row) => expect(row.childCount).toBe(2));
  });

  it('appends a row when at equals the height', () => {
    const { doc } = run(
      [grid()],
      [{ type: 'insert_table_row', tableId: 't', at: 2 }],
    );
    const tableNode = doc.child(0);
    expect(tableNode.childCount).toBe(3);
    expect(tableNode.child(2).childCount).toBe(2);
  });

  it('deletes a row', () => {
    const { doc } = run(
      [grid()],
      [{ type: 'delete_table_row', tableId: 't', at: 1 }],
    );
    const tableNode = doc.child(0);
    expect(tableNode.childCount).toBe(1);
    expect(tableNode.child(0).child(0).textContent).toBe('事项');
  });

  it('refuses to delete the only row', () => {
    expect(() =>
      run(
        [table('t', [['只有一行']])],
        [{ type: 'delete_table_row', tableId: 't', at: 0 }],
      ),
    ).toThrow(BadRequestException);
  });

  it('inserts a column in every row', () => {
    const { doc } = run(
      [grid()],
      [
        {
          type: 'insert_table_column',
          tableId: 't',
          at: 1,
          cells: [[paragraph('负责人')], [paragraph('张')]],
        },
      ],
    );
    const tableNode = doc.child(0);
    tableNode.forEach((row) => expect(row.childCount).toBe(3));
    expect(tableNode.child(0).child(1).textContent).toBe('负责人');
    expect(tableNode.child(1).child(1).textContent).toBe('张');
    expect(tableNode.child(0).child(2).textContent).toBe('状态');
    expect(tableNode.child(1).child(2).textContent).toBe('进行中');
  });

  it('appends a column when at equals the width', () => {
    const { doc } = run(
      [grid()],
      [{ type: 'insert_table_column', tableId: 't', at: 2 }],
    );
    const tableNode = doc.child(0);
    tableNode.forEach((row) => expect(row.childCount).toBe(3));
    expect(tableNode.child(0).child(1).textContent).toBe('状态');
  });

  it('deletes a column from every row', () => {
    const { doc } = run(
      [grid()],
      [{ type: 'delete_table_column', tableId: 't', at: 0 }],
    );
    const tableNode = doc.child(0);
    tableNode.forEach((row) => expect(row.childCount).toBe(1));
    expect(tableNode.child(0).child(0).textContent).toBe('状态');
    expect(tableNode.child(1).child(0).textContent).toBe('进行中');
  });

  it('refuses to delete the only column', () => {
    expect(() =>
      run(
        [table('t', [['只有一列'], ['值']])],
        [{ type: 'delete_table_column', tableId: 't', at: 0 }],
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects a non-table id for a table op', () => {
    expect(() =>
      run(
        [paragraph('x', 'p')],
        [
          {
            type: 'set_table_cell',
            tableId: 'p',
            row: 0,
            col: 0,
            content: [paragraph('y')],
          },
        ],
      ),
    ).toThrow(BadRequestException);
  });
});

describe('applyPageEdits database ops', () => {
  const build = () => {
    const json = buildDatabaseJSON({
      id: 'db',
      title: '任务',
      columns: [
        { id: 'c-name', name: '名称', type: 'text' },
        { id: 'c-done', name: '完成', type: 'checkbox' },
      ],
      views: [{ id: 'v1', name: 'Table', type: 'table' }],
      rows: [
        { id: 'r1', values: { 'c-name': 'A', 'c-done': false } },
        { id: 'r2', values: { 'c-name': 'B', 'c-done': false } },
      ],
    }) as JSONContent;
    return json;
  };

  const readCell = (doc: PMNode, rowId: string, columnId: string) => {
    let value: unknown;
    doc.child(0).forEach((row) => {
      if (row.attrs.id !== rowId) return;
      row.forEach((cellNode) => {
        if (cellNode.attrs.columnId === columnId) value = cellNode.attrs.value;
      });
    });
    return value;
  };

  it('sets a cell value through the database transform', () => {
    const { doc } = run(
      [build()],
      [
        {
          type: 'set_database_cell',
          databaseId: 'db',
          rowId: 'r2',
          columnId: 'c-name',
          value: 'B 改过',
        },
      ],
    );
    expect(readCell(doc, 'r2', 'c-name')).toBe('B 改过');
    expect(readCell(doc, 'r1', 'c-name')).toBe('A');
  });

  it('normalizes the value to the column type', () => {
    const { doc } = run(
      [build()],
      [
        {
          type: 'set_database_cell',
          databaseId: 'db',
          rowId: 'r1',
          columnId: 'c-done',
          value: 'yes',
        },
      ],
    );
    expect(typeof readCell(doc, 'r1', 'c-done')).toBe('boolean');
  });

  it('honours the database cell expectation', () => {
    expect(() =>
      run(
        [build()],
        [
          {
            type: 'set_database_cell',
            databaseId: 'db',
            rowId: 'r1',
            columnId: 'c-name',
            value: 'X',
            expect: { value: '不是这个' },
          },
        ],
      ),
    ).toThrow(BadRequestException);
  });

  it('inserts a row and returns its generated id', () => {
    const { doc, outcomes } = run(
      [build()],
      [
        {
          type: 'insert_database_row',
          databaseId: 'db',
          values: { 'c-name': 'C' },
        },
      ],
    );
    expect(outcomes[0].createdId).toEqual(expect.any(String));
    expect(doc.child(0).childCount).toBe(3);
    expect(readCell(doc, outcomes[0].createdId!, 'c-name')).toBe('C');
  });

  it('deletes a row', () => {
    const { doc } = run(
      [build()],
      [{ type: 'delete_database_row', databaseId: 'db', rowId: 'r1' }],
    );
    expect(doc.child(0).childCount).toBe(1);
    expect(readCell(doc, 'r2', 'c-name')).toBe('B');
  });

  it('reorders rows through rowOrder, not the document', () => {
    const { doc } = run(
      [build()],
      [
        {
          type: 'move_database_row',
          databaseId: 'db',
          rowId: 'r2',
          beforeRowId: 'r1',
        },
      ],
    );
    expect(doc.child(0).attrs.rowOrder).toEqual(['r2', 'r1']);
    expect(doc.child(0).child(0).attrs.id).toBe('r1');
  });

  it('adds a column and returns its id', () => {
    const { doc, outcomes } = run(
      [build()],
      [
        {
          type: 'add_database_column',
          databaseId: 'db',
          name: '负责人',
          columnType: 'text',
        },
      ],
    );
    const created = outcomes[0].createdId!;
    expect(created).toEqual(expect.any(String));
    const columns = doc.child(0).attrs.columns as { id: string }[];
    expect(columns.map((column) => column.id)).toContain(created);
  });

  it('renames a column', () => {
    const { doc } = run(
      [build()],
      [
        {
          type: 'update_database_column',
          databaseId: 'db',
          columnId: 'c-done',
          name: '是否完成',
        },
      ],
    );
    const columns = doc.child(0).attrs.columns as {
      id: string;
      name: string;
    }[];
    expect(columns.find((column) => column.id === 'c-done')?.name).toBe(
      '是否完成',
    );
  });

  it('deletes a column and its cells', () => {
    const { doc } = run(
      [build()],
      [
        {
          type: 'delete_database_column',
          databaseId: 'db',
          columnId: 'c-done',
        },
      ],
    );
    const columns = doc.child(0).attrs.columns as { id: string }[];
    expect(columns.map((column) => column.id)).toEqual(['c-name']);
    expect(readCell(doc, 'r1', 'c-done')).toBeUndefined();
  });

  it('sets the database title', () => {
    const { doc } = run(
      [build()],
      [{ type: 'set_database_title', databaseId: 'db', title: '新标题' }],
    );
    expect(doc.child(0).attrs.title).toBe('新标题');
  });

  it('adds and deletes a view', () => {
    const { doc, outcomes } = run(
      [build()],
      [
        {
          type: 'add_database_view',
          databaseId: 'db',
          name: '看板',
          viewType: 'kanban',
        },
      ],
    );
    const created = outcomes[0].createdId!;
    const views = doc.child(0).attrs.views as { id: string }[];
    expect(views.map((view) => view.id)).toContain(created);

    const after = applyPageEdits(doc, [
      { type: 'delete_database_view', databaseId: 'db', viewId: created },
    ]);
    const remaining = after.doc.child(0).attrs.views as { id: string }[];
    expect(remaining.map((view) => view.id)).not.toContain(created);
  });

  it('refuses to delete the last view', () => {
    const { doc } = run(
      [build()],
      [{ type: 'delete_database_view', databaseId: 'db', viewId: 'v1' }],
    );
    const views = doc.child(0).attrs.views as { id: string }[];
    expect(views).toHaveLength(1);
  });
});
