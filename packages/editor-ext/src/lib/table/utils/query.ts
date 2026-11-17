import type { Node, ResolvedPos } from '@tiptap/pm/model';
import type { Selection } from '@tiptap/pm/state';
import {
  cellAround,
  cellNear,
  CellSelection,
  inSameTable,
} from '@tiptap/pm/tables';

export function isCellSelection(value: unknown): value is CellSelection {
  return value instanceof CellSelection;
}

export function findTable($pos: ResolvedPos): FindParentNodeResult | undefined {
  return findParentNode((node) => node.type.spec.tableRole === 'table', $pos);
}

export function findCellRange(
  selection: Selection,
  anchorHit?: number,
  headHit?: number,
): [ResolvedPos, ResolvedPos] | undefined {
  if (anchorHit == null && headHit == null && isCellSelection(selection)) {
    return [selection.$anchorCell, selection.$headCell];
  }

  const anchor: number = anchorHit ?? headHit ?? selection.anchor;
  const head: number = headHit ?? anchorHit ?? selection.head;

  const doc = selection.$head.doc;

  const $anchorCell = findCellPos(doc, anchor);
  const $headCell = findCellPos(doc, head);

  if ($anchorCell && $headCell && inSameTable($anchorCell, $headCell)) {
    return [$anchorCell, $headCell];
  }
}

export function findCellPos(doc: Node, pos: number): ResolvedPos | undefined {
  const $pos = doc.resolve(pos);
  return cellAround($pos) || cellNear($pos);
}

export interface FindParentNodeResult {
  node: Node;

  pos: number;

  start: number;

  depth: number;
}

export function findParentNode(
  predicate: (node: Node) => boolean,
  $pos: ResolvedPos,
): FindParentNodeResult | undefined {
  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    const node = $pos.node(depth);

    if (predicate(node)) {
      const pos = depth === 0 ? 0 : $pos.before(depth);
      const start = $pos.start(depth);
      return { node, pos, start, depth };
    }
  }
}
