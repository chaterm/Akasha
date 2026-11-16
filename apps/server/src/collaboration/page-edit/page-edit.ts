import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { JSONContent } from '@tiptap/core';
import { Node as PMNode, Schema } from '@tiptap/pm/model';
import { EditorState, Transaction } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import {
  addDatabaseColumn,
  addDatabaseView,
  changeDatabaseColumnType,
  deleteDatabaseColumn,
  deleteDatabaseRow,
  deleteDatabaseView,
  insertDatabaseRow,
  moveDatabaseRow,
  moveDatabaseView,
  setDatabaseCellValue,
  setDatabaseTitle,
  updateDatabaseColumn,
  updateDatabaseView,
} from '@docmost/editor-ext';
import { normalizeEditorNode } from '../content-validation';
import type {
  CellExpectation,
  DatabaseCellExpectation,
  NodeExpectation,
  PageEditOp,
  PageEditOutcome,
} from './page-edit.types';

export const EDIT_MAX_OPS = 50;

function editError(
  code: 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'EDIT_CONFLICT',
  message: string,
  details: Record<string, unknown>,
) {
  const body = { code, message, details };
  return code === 'NOT_FOUND'
    ? new NotFoundException(body)
    : new BadRequestException(body);
}

type Located = { node: PMNode; pos: number };

function locateById(doc: PMNode, id: string): Located | null {
  let found: Located | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs?.id === id) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
}

function requireById(
  doc: PMNode,
  id: string,
  opIndex: number,
  expectedType?: string,
): Located {
  const located = locateById(doc, id);
  if (!located) {
    throw editError('NOT_FOUND', `No node with id ${id}`, {
      opIndex,
      nodeId: id,
    });
  }
  if (expectedType && located.node.type.name !== expectedType) {
    throw editError(
      'INVALID_ARGUMENT',
      `Node ${id} is a ${located.node.type.name}, expected ${expectedType}`,
      { opIndex, nodeId: id, actualType: located.node.type.name },
    );
  }
  return located;
}

function assertNodeExpectation(
  node: PMNode,
  expect: NodeExpectation | undefined,
  opIndex: number,
  nodeId: string,
) {
  if (!expect) return;
  if (expect.nodeType !== undefined && node.type.name !== expect.nodeType) {
    throw editError('EDIT_CONFLICT', 'Node type does not match expect', {
      opIndex,
      nodeId,
      expected: expect.nodeType,
      actual: node.type.name,
    });
  }
  if (
    expect.textContent !== undefined &&
    node.textContent !== expect.textContent
  ) {
    throw editError('EDIT_CONFLICT', 'Node text does not match expect', {
      opIndex,
      nodeId,
      expected: expect.textContent,
      actual: node.textContent,
    });
  }
  if (expect.attrs) {
    for (const [key, value] of Object.entries(expect.attrs)) {
      if (JSON.stringify(node.attrs?.[key]) !== JSON.stringify(value)) {
        throw editError('EDIT_CONFLICT', 'Node attrs do not match expect', {
          opIndex,
          nodeId,
          attr: key,
          expected: value,
          actual: node.attrs?.[key],
        });
      }
    }
  }
}

function parseNode(
  schema: Schema,
  json: JSONContent,
  opIndex: number,
  path: string,
): PMNode {
  const normalized = normalizeEditorNode(json, path);
  try {
    return PMNode.fromJSON(schema, normalized);
  } catch {
    throw editError('INVALID_ARGUMENT', 'Content is not a valid node', {
      opIndex,
      path,
    });
  }
}

function parseNodes(
  schema: Schema,
  list: JSONContent[],
  opIndex: number,
  field: string,
): PMNode[] {
  if (!Array.isArray(list) || !list.length) {
    throw editError('INVALID_ARGUMENT', `${field} must be a non-empty array`, {
      opIndex,
      field,
    });
  }
  return list.map((item, index) =>
    parseNode(schema, item, opIndex, `${field}[${index}]`),
  );
}

function locateTable(doc: PMNode, tableId: string, opIndex: number) {
  const located = requireById(doc, tableId, opIndex, 'table');
  const map = TableMap.get(located.node);
  return { ...located, map };
}

function cellAt(
  table: { node: PMNode; pos: number; map: TableMap },
  row: number,
  col: number,
  opIndex: number,
) {
  if (
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    row < 0 ||
    col < 0 ||
    row >= table.map.height ||
    col >= table.map.width
  ) {
    throw editError('INVALID_ARGUMENT', 'Cell coordinates are out of range', {
      opIndex,
      row,
      col,
      height: table.map.height,
      width: table.map.width,
    });
  }
  const offset = table.map.map[row * table.map.width + col];
  const cellPos = table.pos + 1 + offset;
  const node = table.node.nodeAt(offset);
  if (!node) {
    throw editError('NOT_FOUND', 'No cell at these coordinates', {
      opIndex,
      row,
      col,
    });
  }
  return { node, pos: cellPos };
}

function assertCellExpectation(
  node: PMNode,
  expect: CellExpectation | undefined,
  opIndex: number,
  row: number,
  col: number,
) {
  if (!expect?.textContent) return;
  if (node.textContent !== expect.textContent) {
    throw editError('EDIT_CONFLICT', 'Cell text does not match expect', {
      opIndex,
      row,
      col,
      expected: expect.textContent,
      actual: node.textContent,
    });
  }
}

function assertDatabaseCellExpectation(
  doc: PMNode,
  dbPos: number,
  rowId: string,
  columnId: string,
  expect: DatabaseCellExpectation | undefined,
  opIndex: number,
) {
  if (!expect || expect.value === undefined) return;
  const db = doc.nodeAt(dbPos);
  let actual: unknown;
  let seen = false;
  db?.forEach((row) => {
    if (seen || row.attrs.id !== rowId) return;
    row.forEach((cell) => {
      if (cell.attrs.columnId === columnId) {
        actual = cell.attrs.value ?? null;
        seen = true;
      }
    });
  });
  if (JSON.stringify(actual ?? null) !== JSON.stringify(expect.value ?? null)) {
    throw editError('EDIT_CONFLICT', 'Database cell does not match expect', {
      opIndex,
      rowId,
      columnId,
      expected: expect.value,
      actual: actual ?? null,
    });
  }
}

function databasePos(doc: PMNode, databaseId: string, opIndex: number): number {
  return requireById(doc, databaseId, opIndex, 'database').pos;
}

function applyOp(
  tr: Transaction,
  op: PageEditOp,
  index: number,
): PageEditOutcome {
  const schema = tr.doc.type.schema;
  const outcome: PageEditOutcome = { index, type: op.type };

  switch (op.type) {
    case 'replace_node': {
      const target = requireById(tr.doc, op.nodeId, index);
      assertNodeExpectation(target.node, op.expect, index, op.nodeId);
      const next = parseNode(schema, op.content, index, 'content');
      tr.replaceWith(target.pos, target.pos + target.node.nodeSize, next);
      return outcome;
    }
    case 'update_node_attrs': {
      const target = requireById(tr.doc, op.nodeId, index);
      assertNodeExpectation(target.node, op.expect, index, op.nodeId);
      const allowed = target.node.type.spec.attrs ?? {};
      for (const [key, value] of Object.entries(op.attrs)) {
        if (!(key in allowed)) {
          throw editError(
            'INVALID_ARGUMENT',
            `${target.node.type.name} has no attribute ${key}`,
            { opIndex: index, nodeId: op.nodeId, attr: key },
          );
        }
        tr.setNodeAttribute(target.pos, key, value);
      }
      const updated = tr.doc.nodeAt(target.pos);
      if (updated) {
        try {
          updated.check();
        } catch {
          throw editError(
            'INVALID_ARGUMENT',
            'Attributes violate the editor schema',
            { opIndex: index, nodeId: op.nodeId },
          );
        }
      }
      return outcome;
    }
    case 'insert_before':
    case 'insert_after': {
      const target = requireById(tr.doc, op.nodeId, index);
      assertNodeExpectation(target.node, op.expect, index, op.nodeId);
      const nodes = parseNodes(schema, op.content, index, 'content');
      const at =
        op.type === 'insert_before'
          ? target.pos
          : target.pos + target.node.nodeSize;
      tr.insert(at, nodes);
      return outcome;
    }
    case 'delete_node': {
      const target = requireById(tr.doc, op.nodeId, index);
      assertNodeExpectation(target.node, op.expect, index, op.nodeId);
      tr.delete(target.pos, target.pos + target.node.nodeSize);
      return outcome;
    }
    case 'set_table_cell': {
      const table = locateTable(tr.doc, op.tableId, index);
      const cell = cellAt(table, op.row, op.col, index);
      assertCellExpectation(cell.node, op.expect, index, op.row, op.col);
      const blocks = parseNodes(schema, op.content, index, 'content');
      tr.replaceWith(
        cell.pos + 1,
        cell.pos + cell.node.nodeSize - 1,
        blocks,
      );
      return outcome;
    }
    case 'set_table_cell_attrs': {
      const table = locateTable(tr.doc, op.tableId, index);
      const cell = cellAt(table, op.row, op.col, index);
      assertCellExpectation(cell.node, op.expect, index, op.row, op.col);
      const allowed = cell.node.type.spec.attrs ?? {};
      for (const [key, value] of Object.entries(op.attrs)) {
        if (!(key in allowed)) {
          throw editError(
            'INVALID_ARGUMENT',
            `${cell.node.type.name} has no attribute ${key}`,
            { opIndex: index, attr: key },
          );
        }
        tr.setNodeAttribute(cell.pos, key, value);
      }
      return outcome;
    }
    case 'insert_table_row': {
      const table = locateTable(tr.doc, op.tableId, index);
      const { map } = table;
      if (!Number.isInteger(op.at) || op.at < 0 || op.at > map.height) {
        throw editError('INVALID_ARGUMENT', 'Row index is out of range', {
          opIndex: index,
          at: op.at,
          height: map.height,
        });
      }
      const cellType = op.header
        ? schema.nodes.tableHeader
        : schema.nodes.tableCell;
      const cells: PMNode[] = [];
      for (let col = 0; col < map.width; col += 1) {
        const provided = op.cells?.[col];
        const blocks = provided
          ? parseNodes(schema, provided, index, `cells[${col}]`)
          : [schema.nodes.paragraph.create()];
        cells.push(cellType.create(null, blocks));
      }
      const row = schema.nodes.tableRow.create(null, cells);
      let at = table.pos + table.node.nodeSize - 1;
      if (op.at < map.height) {
        table.node.forEach((child, childOffset, childIndex) => {
          if (childIndex === op.at) at = table.pos + 1 + childOffset;
        });
      }
      tr.insert(at, row);
      return outcome;
    }
    case 'delete_table_row': {
      const table = locateTable(tr.doc, op.tableId, index);
      const { map } = table;
      if (!Number.isInteger(op.at) || op.at < 0 || op.at >= map.height) {
        throw editError('INVALID_ARGUMENT', 'Row index is out of range', {
          opIndex: index,
          at: op.at,
          height: map.height,
        });
      }
      if (map.height === 1) {
        throw editError(
          'INVALID_ARGUMENT',
          'Deleting the only row would leave an invalid table; delete the table instead',
          { opIndex: index },
        );
      }
      let rowPos = -1;
      let rowNode: PMNode | null = null;
      table.node.forEach((child, childOffset, childIndex) => {
        if (childIndex === op.at) {
          rowPos = table.pos + 1 + childOffset;
          rowNode = child;
        }
      });
      if (rowPos < 0 || !rowNode) {
        throw editError('NOT_FOUND', 'No row at this index', {
          opIndex: index,
          at: op.at,
        });
      }
      tr.delete(rowPos, rowPos + rowNode.nodeSize);
      return outcome;
    }
    case 'insert_table_column': {
      const table = locateTable(tr.doc, op.tableId, index);
      const { map } = table;
      if (!Number.isInteger(op.at) || op.at < 0 || op.at > map.width) {
        throw editError('INVALID_ARGUMENT', 'Column index is out of range', {
          opIndex: index,
          at: op.at,
          width: map.width,
        });
      }
      const inserts: { pos: number; node: PMNode }[] = [];
      table.node.forEach((row, rowOffset, rowIndex) => {
        if (row.type.name !== 'tableRow') return;
        const reference =
          op.at < map.width
            ? row.child(Math.min(op.at, row.childCount - 1))
            : row.child(row.childCount - 1);
        const cellType =
          reference.type.name === 'tableHeader'
            ? schema.nodes.tableHeader
            : schema.nodes.tableCell;
        const provided = op.cells?.[rowIndex];
        const blocks = provided
          ? parseNodes(schema, provided, index, `cells[${rowIndex}]`)
          : [schema.nodes.paragraph.create()];
        let cellOffset = 0;
        let placed = false;
        row.forEach((cell, childOffset, childIndex) => {
          if (childIndex === op.at) {
            cellOffset = childOffset;
            placed = true;
          }
        });
        if (!placed) cellOffset = row.content.size;
        inserts.push({
          pos: table.pos + 1 + rowOffset + 1 + cellOffset,
          node: cellType.create(null, blocks),
        });
      });
      for (const insert of inserts.reverse()) {
        tr.insert(insert.pos, insert.node);
      }
      return outcome;
    }
    case 'delete_table_column': {
      const table = locateTable(tr.doc, op.tableId, index);
      const { map } = table;
      if (!Number.isInteger(op.at) || op.at < 0 || op.at >= map.width) {
        throw editError('INVALID_ARGUMENT', 'Column index is out of range', {
          opIndex: index,
          at: op.at,
          width: map.width,
        });
      }
      if (map.width === 1) {
        throw editError(
          'INVALID_ARGUMENT',
          'Deleting the only column would leave an invalid table; delete the table instead',
          { opIndex: index },
        );
      }
      const ranges: { from: number; to: number }[] = [];
      table.node.forEach((row, rowOffset) => {
        if (row.type.name !== 'tableRow') return;
        row.forEach((cell, cellOffset, cellIndex) => {
          if (cellIndex !== op.at) return;
          const from = table.pos + 1 + rowOffset + 1 + cellOffset;
          ranges.push({ from, to: from + cell.nodeSize });
        });
      });
      for (const range of ranges.reverse()) {
        tr.delete(range.from, range.to);
      }
      return outcome;
    }
    case 'set_database_cell': {
      const pos = databasePos(tr.doc, op.databaseId, index);
      assertDatabaseCellExpectation(
        tr.doc,
        pos,
        op.rowId,
        op.columnId,
        op.expect,
        index,
      );
      setDatabaseCellValue(
        tr,
        pos,
        op.rowId,
        op.columnId,
        op.value as never,
      );
      return outcome;
    }
    case 'insert_database_row': {
      const pos = databasePos(tr.doc, op.databaseId, index);
      outcome.createdId = insertDatabaseRow(tr, pos, {
        values: op.values as never,
        beforeRowId: op.beforeRowId ?? null,
        afterRowId: op.afterRowId ?? null,
      });
      return outcome;
    }
    case 'delete_database_row': {
      const pos = databasePos(tr.doc, op.databaseId, index);
      deleteDatabaseRow(tr, pos, op.rowId);
      return outcome;
    }
    case 'move_database_row': {
      const pos = databasePos(tr.doc, op.databaseId, index);
      moveDatabaseRow(tr, pos, op.rowId, op.beforeRowId);
      return outcome;
    }
    case 'set_database_title': {
      const pos = databasePos(tr.doc, op.databaseId, index);
      setDatabaseTitle(tr, pos, op.title);
      return outcome;
    }
    case 'add_database_column': {
      const pos = databasePos(tr.doc, op.databaseId, index);
      outcome.createdId = addDatabaseColumn(
        tr,
        pos,
        {
          name: op.name,
          type: op.columnType as never,
          ...(op.options ? { options: op.options as never } : {}),
        },
        op.anchorId
          ? { anchorId: op.anchorId, side: op.side ?? 'right' }
          : undefined,
      );
      return outcome;
    }
    case 'update_database_column': {
      const pos = databasePos(tr.doc, op.databaseId, index);
      const patch: Record<string, unknown> = {};
      if (op.name !== undefined) patch.name = op.name;
      if (op.options !== undefined) patch.options = op.options;
      if (op.format !== undefined) patch.format = op.format;
      if (op.decimals !== undefined) patch.decimals = op.decimals;
      updateDatabaseColumn(tr, pos, op.columnId, patch as never);
      return outcome;
    }
    case 'change_database_column_type': {
      const pos = databasePos(tr.doc, op.databaseId, index);
      changeDatabaseColumnType(
        tr,
        pos,
        op.columnId,
        op.columnType as never,
      );
      return outcome;
    }
    case 'delete_database_column': {
      const pos = databasePos(tr.doc, op.databaseId, index);
      deleteDatabaseColumn(tr, pos, op.columnId);
      return outcome;
    }
    case 'add_database_view': {
      const pos = databasePos(tr.doc, op.databaseId, index);
      outcome.createdId = addDatabaseView(tr, pos, {
        name: op.name,
        type: op.viewType as never,
      });
      return outcome;
    }
    case 'update_database_view': {
      const pos = databasePos(tr.doc, op.databaseId, index);
      updateDatabaseView(tr, pos, op.viewId, op.patch as never);
      return outcome;
    }
    case 'delete_database_view': {
      const pos = databasePos(tr.doc, op.databaseId, index);
      deleteDatabaseView(tr, pos, op.viewId);
      return outcome;
    }
    case 'move_database_view': {
      const pos = databasePos(tr.doc, op.databaseId, index);
      moveDatabaseView(tr, pos, op.viewId, op.beforeViewId);
      return outcome;
    }
    default: {
      const unknown = op as { type?: string };
      throw editError('INVALID_ARGUMENT', 'Unknown edit operation', {
        opIndex: index,
        opType: unknown?.type,
      });
    }
  }
}

export function applyPageEdits(
  doc: PMNode,
  ops: PageEditOp[],
): { doc: PMNode; outcomes: PageEditOutcome[] } {
  if (!Array.isArray(ops) || !ops.length) {
    throw editError('INVALID_ARGUMENT', 'ops must be a non-empty array', {});
  }
  if (ops.length > EDIT_MAX_OPS) {
    throw editError('INVALID_ARGUMENT', `At most ${EDIT_MAX_OPS} ops per call`, {
      count: ops.length,
      limit: EDIT_MAX_OPS,
    });
  }
  const state = EditorState.create({ doc });
  const tr = state.tr;
  const outcomes = ops.map((op, index) => applyOp(tr, op, index));
  try {
    tr.doc.check();
  } catch {
    throw editError(
      'INVALID_ARGUMENT',
      'The resulting document violates the editor schema',
      {},
    );
  }
  return { doc: tr.doc, outcomes };
}
