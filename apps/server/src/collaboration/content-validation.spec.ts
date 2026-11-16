import { BadRequestException, Logger } from '@nestjs/common';
import type { JSONContent } from '@tiptap/core';
import { jsonToNode } from './collaboration.util';
import {
  normalizeEditorDocument,
  normalizeEditorNode,
} from './content-validation';

describe('strict editor content validation', () => {
  beforeEach(() =>
    jest.spyOn(Logger, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => jest.restoreAllMocks());

  const paragraph = (text: string): JSONContent => ({
    type: 'paragraph',
    content: [{ type: 'text', text }],
  });

  it('adds schema defaults without mutating the caller snapshot', () => {
    const input: JSONContent = { type: 'doc', content: [paragraph('正文')] };
    const snapshot = structuredClone(input);
    const result = normalizeEditorDocument(input);
    expect(input).toEqual(snapshot);
    expect(result.content[0].attrs).toEqual(
      expect.objectContaining({ textAlign: null }),
    );
    expect(result.content[0].content[0].text).toBe('正文');
  });

  it('rejects an unknown node instead of unwrapping it like jsonToNode does', () => {
    const input: JSONContent = {
      type: 'doc',
      content: [{ type: 'callOut', content: [paragraph('风险')] }],
    };
    const parserInput = structuredClone(input);
    expect(jsonToNode(parserInput).toJSON().content[0].type).toBe('paragraph');
    expect(() => normalizeEditorDocument(input)).toThrow(BadRequestException);
  });

  it('reports the unknown node type in the error details', () => {
    const input: JSONContent = { type: 'doc', content: [{ type: 'bogus' }] };
    try {
      normalizeEditorDocument(input);
      throw new Error('expected a rejection');
    } catch (error: any) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toEqual(
        expect.objectContaining({ code: 'INVALID_CONTENT' }),
      );
    }
  });

  it('validates a standalone block that is not valid directly under doc', () => {
    const row: JSONContent = {
      type: 'tableRow',
      content: [
        {
          type: 'tableCell',
          attrs: { colspan: 1, rowspan: 1, colwidth: [120] },
          content: [paragraph('单元格')],
        },
      ],
    };
    const result = normalizeEditorNode(row);
    expect(result.type).toBe('tableRow');
    expect(result.content[0].attrs.colwidth).toEqual([120]);
  });

  it('keeps explicit table and status attributes', () => {
    const cell: JSONContent = {
      type: 'tableCell',
      attrs: { colspan: 2, rowspan: 1, colwidth: [200, 110] },
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'status', attrs: { text: '待确认', color: 'gray' } }],
        },
      ],
    };
    const result = normalizeEditorNode(cell);
    expect(result.attrs).toEqual(
      expect.objectContaining({ colspan: 2, colwidth: [200, 110] }),
    );
    expect(result.content[0].content[0].attrs).toEqual(
      expect.objectContaining({ text: '待确认', color: 'gray' }),
    );
  });

  it('accepts the editor node types the Skill documents', () => {
    const types: JSONContent[] = [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] },
      {
        type: 'callout',
        attrs: { type: 'warning' },
        content: [paragraph('注意')],
      },
      {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: false },
            content: [paragraph('待办')],
          },
        ],
      },
      { type: 'mathInline', attrs: { text: 'x^2' } },
      { type: 'pageBreak' },
    ];
    for (const node of types) {
      expect(normalizeEditorNode(node).type).toBe(node.type);
    }
  });

  it('rejects an attribute the schema does not know, instead of dropping it', () => {
    expect(() =>
      normalizeEditorNode({ type: 'mathInline', attrs: { katex: 'x^2' } }),
    ).toThrow(BadRequestException);
  });

  it('rejects a non-doc root for document normalization', () => {
    expect(() => normalizeEditorDocument(paragraph('x'))).toThrow(
      BadRequestException,
    );
  });

  it('rejects content that exceeds the node budget', () => {
    const content = Array.from({ length: 31_000 }, () => paragraph('x'));
    expect(() => normalizeEditorDocument({ type: 'doc', content })).toThrow(
      BadRequestException,
    );
  });
});
