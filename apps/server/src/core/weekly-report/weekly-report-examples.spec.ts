import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { TableMap } from '@tiptap/pm/tables';
import {
  jsonToNode,
  jsonToText,
  tiptapExtensions,
} from '../../collaboration/collaboration.util';
import { BUILTIN_TEMPLATES } from '../template/builtin-templates';
import { normalizeWeeklyReportContent } from './weekly-report-content';

/** The Skill tells the model to copy these examples; they must survive the real save path. */
const rulesPath = resolve(
  __dirname,
  '../../../../../skills/akasha-weekly-report/references/content-rules.md',
);
const examples = [
  ...readFileSync(rulesPath, 'utf8').matchAll(/```json\s*\n([\s\S]*?)\n```/g),
].map((match) => JSON.parse(match[1]));

// Schema-added defaults are allowed; loss/change of any explicitly supplied value is not.
function expectPreserved(raw: any, normalized: any, path = '$'): void {
  if (Array.isArray(raw)) {
    expect({ path, isArray: Array.isArray(normalized) }).toEqual({
      path,
      isArray: true,
    });
    expect({ path, length: normalized.length }).toEqual({
      path,
      length: raw.length,
    });
    raw.forEach((value, index) =>
      expectPreserved(value, normalized[index], `${path}[${index}]`),
    );
  } else if (raw !== null && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      expect({ path: `${path}.${key}`, present: key in (normalized ?? {}) })
        .toEqual({ path: `${path}.${key}`, present: true });
      expectPreserved(value, normalized[key], `${path}.${key}`);
    }
  } else {
    expect({ path, value: normalized }).toEqual({ path, value: raw });
  }
}

function collectTypes(raw: any) {
  const node = jsonToNode(structuredClone(raw));
  const nodes = new Set<string>([node.type.name]);
  const marks = new Set<string>();
  node.descendants((child) => {
    nodes.add(child.type.name);
    child.marks.forEach((mark) => marks.add(mark.type.name));
  });
  return { nodes, marks };
}

const builtin = BUILTIN_TEMPLATES.find((template) => template.title === '周报');
const cases: Array<[string, any]> = [
  ...examples.map((example, index): [string, any] => [
    `content-rules example ${index + 1}`,
    example,
  ]),
  ['repository builtin weekly report', builtin?.content],
];

describe('weekly report Skill content examples', () => {
  it('extracts examples and finds the builtin weekly report', () => {
    expect(examples.length).toBeGreaterThan(0);
    expect(builtin).toBeDefined();
  });

  it.each(cases)('%s survives schema, normalizer and Y.Doc', (_, raw) => {
    const snapshot = structuredClone(raw);
    const node = jsonToNode(structuredClone(snapshot));
    node.check();
    const normalized = node.toJSON();
    expectPreserved(snapshot, normalized);
    expect(normalizeWeeklyReportContent(snapshot)).toEqual(normalized);

    node.descendants((child) => {
      if (child.type.name === 'table')
        expect(TableMap.get(child).problems).toBeNull();
    });

    // Rehydrate as plain JSON: Yjs checks attribute array constructors per realm.
    const ydoc = TiptapTransformer.toYdoc(
      JSON.parse(JSON.stringify(normalized)),
      'default',
      tiptapExtensions,
    );
    try {
      const readback = jsonToNode(TiptapTransformer.fromYdoc(ydoc, 'default'));
      readback.check();
      expect(readback.toJSON()).toEqual(normalized);
      expect(jsonToText(readback.toJSON())).toEqual(jsonToText(normalized));
    } finally {
      ydoc.destroy();
    }
  });

  it('covers the node and mark types the Skill relies on', () => {
    const nodes = new Set<string>();
    const marks = new Set<string>();
    for (const example of examples) {
      const found = collectTypes(example);
      found.nodes.forEach((name) => nodes.add(name));
      found.marks.forEach((name) => marks.add(name));
    }
    for (const name of [
      'doc',
      'paragraph',
      'text',
      'heading',
      'table',
      'tableRow',
      'tableHeader',
      'tableCell',
      'status',
      'callout',
      'taskList',
      'taskItem',
    ])
      expect(nodes).toContain(name);
    for (const name of ['bold', 'link']) expect(marks).toContain(name);
  });
});
