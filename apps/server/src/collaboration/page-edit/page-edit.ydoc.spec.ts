import type { JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { initProseMirrorDoc, updateYFragment } from '@tiptap/y-tiptap';
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import { buildDatabaseJSON } from '@docmost/editor-ext';
import { tiptapExtensions } from '../collaboration.util';
import { applyPageEdits } from './page-edit';
import type { PageEditOp } from './page-edit.types';

const schema = getSchema(tiptapExtensions);

const createYdoc = (json: JSONContent): Y.Doc =>
  TiptapTransformer.toYdoc(json, 'default', tiptapExtensions);

const paragraph = (text: string, id: string): JSONContent => ({
  type: 'paragraph',
  attrs: { id },
  content: [{ type: 'text', text }],
});

function editYdoc(ydoc: Y.Doc, ops: PageEditOp[]) {
  const fragment = ydoc.getXmlFragment('default');
  const { doc, mapping } = initProseMirrorDoc(fragment, schema);
  const result = applyPageEdits(doc, ops);
  updateYFragment(ydoc, fragment, result.doc, {
    mapping,
    isOMark: new Map(),
  });
  return result.outcomes;
}

const readBack = (ydoc: Y.Doc) =>
  TiptapTransformer.fromYdoc(ydoc, 'default') as JSONContent;

describe('page edits through the real Yjs document', () => {
  const source = (): JSONContent => ({
    type: 'doc',
    content: [
      paragraph('第一段', 'p1'),
      paragraph('第二段', 'p2'),
      {
        type: 'table',
        attrs: { id: 't1' },
        content: [
          {
            type: 'tableRow',
            content: ['事项', '状态'].map((text) => ({
              type: 'tableHeader',
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
            })),
          },
          {
            type: 'tableRow',
            content: ['联调', '进行中'].map((text) => ({
              type: 'tableCell',
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
            })),
          },
        ],
      },
    ],
  });

  it('writes a block edit back into the Y.Doc', () => {
    const ydoc = createYdoc(source());
    editYdoc(ydoc, [
      { type: 'replace_node', nodeId: 'p2', content: paragraph('改过的第二段', 'p2') },
    ]);
    const result = readBack(ydoc);
    expect(result.content[0].content[0].text).toBe('第一段');
    expect(result.content[1].content[0].text).toBe('改过的第二段');
  });

  it('writes a table cell edit addressed by coordinates', () => {
    const ydoc = createYdoc(source());
    editYdoc(ydoc, [
      {
        type: 'set_table_cell',
        tableId: 't1',
        row: 1,
        col: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '已完成' }] }],
      },
    ]);
    const table = readBack(ydoc).content[2];
    expect(table.content[1].content[1].content[0].content[0].text).toBe('已完成');
    expect(table.content[1].content[0].content[0].content[0].text).toBe('联调');
    expect(table.content[0].content[0].content[0].content[0].text).toBe('事项');
  });

  it('leaves the Yjs identity of untouched blocks alone', () => {
    const ydoc = createYdoc(source());
    const fragment = ydoc.getXmlFragment('default');
    const before = fragment.get(0) as Y.XmlElement;
    const beforeId = `${before._item?.id.client}:${before._item?.id.clock}`;

    editYdoc(ydoc, [
      { type: 'replace_node', nodeId: 'p2', content: paragraph('新内容', 'p2') },
    ]);

    const after = ydoc.getXmlFragment('default').get(0) as Y.XmlElement;
    expect(`${after._item?.id.client}:${after._item?.id.clock}`).toBe(beforeId);
  });

  it('merges concurrent edits to different blocks, which a full replace loses', () => {
    const alice = createYdoc(source());
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    editYdoc(alice, [
      { type: 'replace_node', nodeId: 'p1', content: paragraph('Alice 改第一段', 'p1') },
    ]);
    editYdoc(bob, [
      { type: 'replace_node', nodeId: 'p2', content: paragraph('Bob 改第二段', 'p2') },
    ]);

    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    for (const ydoc of [alice, bob]) {
      const result = readBack(ydoc);
      expect(result.content[0].content[0].text).toBe('Alice 改第一段');
      expect(result.content[1].content[0].text).toBe('Bob 改第二段');
    }
  });

  it('merges concurrent edits to different cells of one table', () => {
    const alice = createYdoc(source());
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    editYdoc(alice, [
      {
        type: 'set_table_cell',
        tableId: 't1',
        row: 1,
        col: 0,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '联调完成' }] }],
      },
    ]);
    editYdoc(bob, [
      {
        type: 'set_table_cell',
        tableId: 't1',
        row: 1,
        col: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '已完成' }] }],
      },
    ]);

    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
    const table = readBack(alice).content[2];
    expect(table.content[1].content[0].content[0].content[0].text).toBe('联调完成');
    expect(table.content[1].content[1].content[0].content[0].text).toBe('已完成');
  });

  it('merges concurrent database cell edits per cell', () => {
    const database = buildDatabaseJSON({
      id: 'db',
      title: '任务',
      columns: [
        { id: 'c-name', name: '名称', type: 'text' },
        { id: 'c-owner', name: '负责人', type: 'text' },
      ],
      views: [{ id: 'v1', name: 'Table', type: 'table' }],
      rows: [{ id: 'r1', values: { 'c-name': 'A', 'c-owner': '' } }],
    }) as JSONContent;

    const alice = createYdoc({ type: 'doc', content: [database] });
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    editYdoc(alice, [
      {
        type: 'set_database_cell',
        databaseId: 'db',
        rowId: 'r1',
        columnId: 'c-name',
        value: 'A 改过',
      },
    ]);
    editYdoc(bob, [
      {
        type: 'set_database_cell',
        databaseId: 'db',
        rowId: 'r1',
        columnId: 'c-owner',
        value: '张',
      },
    ]);

    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
    const row = readBack(alice).content[0].content[0];
    const values = Object.fromEntries(
      row.content.map((cell: JSONContent) => [
        cell.attrs.columnId,
        cell.attrs.value,
      ]),
    );
    expect(values['c-name']).toBe('A 改过');
    expect(values['c-owner']).toBe('张');
  });

  it('applies a batch of ops as one Yjs transaction', () => {
    const ydoc = createYdoc(source());
    let updates = 0;
    ydoc.on('update', () => {
      updates += 1;
    });

    ydoc.transact(() => {
      editYdoc(ydoc, [
        { type: 'replace_node', nodeId: 'p1', content: paragraph('一', 'p1') },
        { type: 'replace_node', nodeId: 'p2', content: paragraph('二', 'p2') },
        {
          type: 'set_table_cell',
          tableId: 't1',
          row: 1,
          col: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '完成' }] }],
        },
      ]);
    });

    expect(updates).toBe(1);
    const result = readBack(ydoc);
    expect(result.content[0].content[0].text).toBe('一');
    expect(result.content[1].content[0].text).toBe('二');
    expect(
      result.content[2].content[1].content[1].content[0].content[0].text,
    ).toBe('完成');
  });

  it('writes nothing when an op in the batch conflicts', () => {
    const ydoc = createYdoc(source());
    const before = JSON.stringify(readBack(ydoc));

    expect(() =>
      ydoc.transact(() => {
        editYdoc(ydoc, [
          { type: 'replace_node', nodeId: 'p1', content: paragraph('改了', 'p1') },
          {
            type: 'replace_node',
            nodeId: 'p2',
            content: paragraph('也改了', 'p2'),
            expect: { textContent: '不匹配的旧值' },
          },
        ]);
      }),
    ).toThrow();

    expect(JSON.stringify(readBack(ydoc))).toBe(before);
  });
});
