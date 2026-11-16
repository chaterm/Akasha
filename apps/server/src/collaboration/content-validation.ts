import { BadRequestException } from '@nestjs/common';
import type { JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { Node } from '@tiptap/pm/model';
import { tiptapExtensions } from './collaboration.util';

export const CONTENT_MAX_BYTES = 1_000_000;
export const CONTENT_MAX_NODES = 30_000;
export const CONTENT_MAX_DEPTH = 100;

export function invalidContent(path: string, message?: string) {
  return new BadRequestException({
    code: 'INVALID_CONTENT',
    message: message ?? 'Content would lose data or violates the editor schema',
    details: { path },
  });
}

function assertBounded(raw: unknown, path: string): void {
  let count = 0;
  const walk = (value: any, depth: number) => {
    if (++count > CONTENT_MAX_NODES || depth > CONTENT_MAX_DEPTH) {
      throw invalidContent(path);
    }
    if (value && typeof value === 'object') {
      Object.values(value).forEach((child) => walk(child, depth + 1));
    }
  };
  walk(raw, 0);
}

function assertPreserved(before: any, after: any, path: string, key?: string) {
  if (Array.isArray(before)) {
    if (
      !before.length &&
      after === undefined &&
      (key === 'content' || key === 'marks')
    ) {
      return;
    }
    if (!Array.isArray(after) || before.length !== after.length) {
      throw invalidContent(path);
    }
    const sortMarks = (marks: any[]) =>
      [...marks].sort((a, b) => String(a.type).localeCompare(String(b.type)));
    const left = key === 'marks' ? sortMarks(before) : before;
    const right = key === 'marks' ? sortMarks(after) : after;
    left.forEach((value, index) =>
      assertPreserved(value, right[index], `${path}[${index}]`),
    );
  } else if (before && typeof before === 'object') {
    if (key === 'attrs' && !Object.keys(before).length && after === undefined) {
      return;
    }
    if (!after || typeof after !== 'object' || Array.isArray(after)) {
      throw invalidContent(path);
    }
    for (const field of Object.keys(before)) {
      assertPreserved(before[field], after[field], `${path}.${field}`, field);
    }
  } else if (before !== after) {
    throw invalidContent(path);
  }
}

export function normalizeEditorNode(
  raw: JSONContent,
  path = '$',
): JSONContent {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.type) {
      throw invalidContent(path);
    }
    if (Buffer.byteLength(JSON.stringify(raw)) > CONTENT_MAX_BYTES) {
      throw invalidContent(path);
    }
    assertBounded(raw, path);
    const schema = getSchema(tiptapExtensions);
    if (!schema.nodes[raw.type]) {
      throw invalidContent(path, `Unknown node type: ${raw.type}`);
    }
    const node = Node.fromJSON(schema, JSON.parse(JSON.stringify(raw)));
    node.check();
    const normalized = node.toJSON();
    assertPreserved(raw, normalized, path);
    return normalized;
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw invalidContent(path);
  }
}

export function normalizeEditorDocument(raw: JSONContent): JSONContent {
  if (!raw || raw.type !== 'doc') throw invalidContent('$');
  return normalizeEditorNode(raw, '$');
}
