import type { Node } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';

export function convertTableNodeToArrayOfRows(
  tableNode: Node,
): (Node | null)[][] {
  const map = TableMap.get(tableNode);
  const rows: (Node | null)[][] = [];
  const rowCount = map.height;
  const colCount = map.width;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const row: (Node | null)[] = [];
    for (let colIndex = 0; colIndex < colCount; colIndex++) {
      let cellIndex = rowIndex * colCount + colIndex;
      let cellPos = map.map[cellIndex];
      if (rowIndex > 0) {
        const topCellIndex = cellIndex - colCount;
        const topCellPos = map.map[topCellIndex];
        if (cellPos === topCellPos) {
          row.push(null);
          continue;
        }
      }
      if (colIndex > 0) {
        const leftCellIndex = cellIndex - 1;
        const leftCellPos = map.map[leftCellIndex];
        if (cellPos === leftCellPos) {
          row.push(null);
          continue;
        }
      }
      row.push(tableNode.nodeAt(cellPos));
    }
    rows.push(row);
  }

  return rows;
}
