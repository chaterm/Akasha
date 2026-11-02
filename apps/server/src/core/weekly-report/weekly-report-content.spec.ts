import { BadRequestException, Logger } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import type { JSONContent } from '@tiptap/core';
import { jsonToNode, jsonToText } from '../../collaboration/collaboration.util';
import { createYdocFromJson } from '../../common/helpers/prosemirror/utils';
import {
  BUILTIN_TEMPLATES,
  BUILTIN_WEEKLY_REPORT_ID,
} from '../template/builtin-templates';
import { normalizeWeeklyReportContent as normalize } from './weekly-report-content';

describe('strict weekly report editor normalization', () => {
  const doc = (): JSONContent => ({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '真实工作成果' }] },
    ],
  });
  beforeEach(() =>
    jest.spyOn(Logger, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => jest.restoreAllMocks());

  it('adds schema defaults without mutating the caller snapshot', () => {
    const input = doc();
    const snapshot = structuredClone(input);
    const result = normalize(input);
    expect(input).toEqual(snapshot);
    expect(result).toEqual(jsonToNode(structuredClone(input)).toJSON());
    expect(result.content[0].attrs).toEqual(
      expect.objectContaining({ textAlign: null }),
    );
    expect(result.content[0].content[0].text).toBe('真实工作成果');
  });

  it('rejects unknown nodes even when the compatibility parser unwraps them in place', () => {
    const input: JSONContent = {
      type: 'doc',
      content: [{ type: 'unknownWeeklySection', content: doc().content }],
    };
    const snapshot = structuredClone(input);
    const parserInput = structuredClone(input);
    expect(jsonToNode(parserInput).toJSON().content[0].type).toBe('paragraph');
    expect(parserInput).not.toEqual(snapshot);
    expect(() => normalize(input)).toThrow(BadRequestException);
    expect(input).toEqual(snapshot);
  });

  it.each([
    { ...doc(), unsupported: 'must not disappear' },
    {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { invented: 'lost' } }],
    },
    {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'invented' }] }],
        },
      ],
    },
    { type: 'doc', content: [{ type: 'text', text: 'invalid root child' }] },
    { type: 'paragraph' },
    null,
  ])('rejects loss or invalid schema content: %j', (input) => {
    try {
      normalize(input as JSONContent);
      throw new Error('Expected INVALID_CONTENT');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'INVALID_CONTENT',
        details: { path: expect.any(String) },
      });
    }
  });

  it('accepts empty content/marks arrays and equivalent mark ordering', () => {
    const input: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: {}, content: [], marks: [] },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'linked',
              marks: [
                { type: 'link', attrs: { href: 'https://example.com' } },
                { type: 'bold' },
              ],
            },
          ],
        },
      ],
    };
    expect(
      normalize(input)
        .content[1].content[0].marks.map((mark) => mark.type)
        .sort(),
    ).toEqual(['bold', 'link']);
  });

  it('bounds payload bytes, nesting, and node count before saving', () => {
    const large = doc();
    large.content[0].content[0].text = '文'.repeat(350_000);
    expect(() => normalize(large)).toThrow(BadRequestException);
    let nested: JSONContent = { type: 'paragraph' };
    for (let i = 0; i < 110; i++)
      nested = { type: 'blockquote', content: [nested] };
    expect(() => normalize({ type: 'doc', content: [nested] })).toThrow(
      BadRequestException,
    );
    expect(() =>
      normalize({
        type: 'doc',
        content: Array.from({ length: 16_000 }, () => ({ type: 'paragraph' })),
      }),
    ).toThrow(BadRequestException);
  });

  it('preserves built-in weekly report blocks, marks, body text, and attributes through stored Y.Doc bytes', () => {
    const builtin = BUILTIN_TEMPLATES.find(
      (template) => template.id === BUILTIN_WEEKLY_REPORT_ID,
    )!;
    const input = structuredClone(builtin.content) as JSONContent;
    input.content.push({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: '交付结果',
          marks: [
            { type: 'bold' },
            { type: 'link', attrs: { href: 'https://example.com/source' } },
          ],
        },
        { type: 'status', attrs: { text: '待确认', color: 'yellow' } },
      ],
    });
    const content = normalize(input);
    const bytes = createYdocFromJson(content);
    expect(bytes).toBeInstanceOf(Buffer);
    const ydoc = new Y.Doc();
    try {
      Y.applyUpdate(ydoc, bytes);
      const restored = TiptapTransformer.fromYdoc(
        ydoc,
        'default',
      ) as JSONContent;
      expect(normalize(restored)).toEqual(content);
      expect(jsonToText(restored)).toEqual(jsonToText(content));
      const types = new Set<string>();
      jsonToNode(restored).descendants((node) => {
        types.add(node.type.name);
      });
      for (const type of [
        'heading',
        'table',
        'tableHeader',
        'tableCell',
        'status',
        'callout',
        'taskList',
        'taskItem',
      ])
        expect(types.has(type)).toBe(true);
      expect(jsonToNode(restored).toJSON()).toEqual(content);
    } finally {
      ydoc.destroy();
    }
  });
});
