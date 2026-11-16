import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSchema } from '@tiptap/core';
import { ADDRESSABLE_NODE_TYPES } from '@docmost/editor-ext';
import { tiptapExtensions } from '../collaboration.util';
import { buildNodeReference, renderNodeReference } from './node-reference';

const referencePath = resolve(
  __dirname,
  '../../../../../akasha-plugin/skills/akasha-pages/references/node-reference.md',
);

describe('generated node reference', () => {
  it('matches the committed file, so the Skill reference cannot go stale', () => {
    expect(readFileSync(referencePath, 'utf8')).toBe(renderNodeReference());
  });

  it('covers every node and mark in the server schema', () => {
    const schema = getSchema(tiptapExtensions);
    const { nodes, marks } = buildNodeReference();
    expect(nodes.map((node) => node.name).sort()).toEqual(
      Object.keys(schema.nodes).sort(),
    );
    expect(marks.map((mark) => mark.name).sort()).toEqual(
      Object.keys(schema.marks).sort(),
    );
  });

  it('marks exactly the addressable types as addressable', () => {
    const { nodes } = buildNodeReference();
    const flagged = nodes
      .filter((node) => node.addressable)
      .map((node) => node.name)
      .sort();
    expect(flagged).toEqual([...ADDRESSABLE_NODE_TYPES].sort());
  });

  it('declares every addressable type in the schema', () => {
    const schema = getSchema(tiptapExtensions);
    for (const type of ADDRESSABLE_NODE_TYPES) {
      expect(schema.nodes[type]).toBeDefined();
      expect(schema.nodes[type].spec.attrs).toHaveProperty('id');
    }
  });

  it('gives table cells and database cells no id attribute', () => {
    const schema = getSchema(tiptapExtensions);
    for (const type of [
      'tableCell',
      'tableHeader',
      'tableRow',
      'databaseCell',
    ]) {
      expect({
        type,
        hasId: 'id' in (schema.nodes[type].spec.attrs ?? {}),
      }).toEqual({ type, hasId: false });
    }
  });
});
