import type { Selection } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';

import { findTable } from './query';
import type { CellPos } from './types';

export function getCellsInRow(
  rowIndex: number | number[],
  selection: Selection,
): CellPos[] | undefined {
  const table = findTable(selection.$from);
  if (!table) {
    return;
  }

  const map = TableMap.get(table.node);
  const indexes = Array.isArray(rowIndex) ? rowIndex : [rowIndex];

  return indexes
    .filter((index) => index >= 0 && index <= map.height - 1)
    .flatMap((index) => {
      const cells = map.cellsInRect({
        left: 0,
        right: map.width,
        top: index,
        bottom: index + 1,
      });
      return cells.map((nodePos) => {
        const node = table.node.nodeAt(nodePos)!;
        const pos = nodePos + table.start;
        return { pos, start: pos + 1, node, depth: table.depth + 2 };
      });
    });
}
