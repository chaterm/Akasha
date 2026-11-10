import { BadRequestException } from '@nestjs/common';
import { jsonToNode } from '../../collaboration/collaboration.util';
import type { JSONContent } from '@tiptap/core';

/** Preserve the input snapshot: jsonToNode's compatibility cleanup mutates it. */
export function normalizeWeeklyReportContent(raw: JSONContent): JSONContent {
  const invalid = (path: string) =>
    new BadRequestException({
      code: 'INVALID_CONTENT',
      message: 'Content would lose data or violates the editor schema',
      details: { path },
    });
  try {
    if (
      !raw ||
      raw.type !== 'doc' ||
      Buffer.byteLength(JSON.stringify(raw)) > 1_000_000
    ) {
      throw invalid('$');
    }
    let count = 0;
    const bound = (value: any, depth: number) => {
      if (++count > 30_000 || depth > 100) throw invalid('$');
      if (value && typeof value === 'object')
        Object.values(value).forEach((v) => bound(v, depth + 1));
    };
    bound(raw, 0);
    // Document JSON is plain data. Rehydrate in this realm as Yjs checks the
    // constructors of nested attribute arrays/objects (e.g. table colwidth).
    const node = jsonToNode(JSON.parse(JSON.stringify(raw)));
    node.check();
    const normalized = node.toJSON();
    const compare = (before: any, after: any, path: string, key?: string) => {
      if (Array.isArray(before)) {
        if (
          !before.length &&
          after === undefined &&
          (key === 'content' || key === 'marks')
        )
          return;
        if (!Array.isArray(after) || before.length !== after.length)
          throw invalid(path);
        const sortMarks = (a: any[]) =>
          [...a].sort((x, y) => String(x.type).localeCompare(String(y.type)));
        const left = key === 'marks' ? sortMarks(before) : before;
        const right = key === 'marks' ? sortMarks(after) : after;
        left.forEach((v, i) => compare(v, right[i], `${path}[${i}]`));
      } else if (before && typeof before === 'object') {
        if (
          key === 'attrs' &&
          !Object.keys(before).length &&
          after === undefined
        )
          return;
        if (!after || typeof after !== 'object' || Array.isArray(after))
          throw invalid(path);
        for (const k of Object.keys(before))
          compare(before[k], after[k], `${path}.${k}`, k);
      } else if (before !== after) throw invalid(path);
    };
    compare(raw, normalized, '$');
    return normalized;
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw invalid('$');
  }
}
