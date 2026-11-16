import { z } from 'zod/v4';
import { EDIT_MAX_OPS } from '../../collaboration/page-edit/page-edit';

const nodeId = z
  .string()
  .min(1)
  .describe('Stable node id from get_page content.');

const jsonContent = z
  .record(z.string(), z.any())
  .describe('One Tiptap node as a JSON object.');

const jsonContentList = z
  .array(jsonContent)
  .min(1)
  .describe('Tiptap nodes as JSON objects.');

const nodeExpectation = z
  .object({
    nodeType: z.string().optional(),
    textContent: z.string().optional(),
    attrs: z.record(z.string(), z.any()).optional(),
  })
  .optional()
  .describe(
    'Assertion about the node as it is now. The whole call fails with EDIT_CONFLICT when it does not hold.',
  );

const cellExpectation = z
  .object({ textContent: z.string().optional() })
  .optional()
  .describe('Assertion about the cell text as it is now.');

const databaseColumnType = z.enum([
  'text',
  'number',
  'select',
  'multiSelect',
  'date',
  'checkbox',
  'person',
  'url',
]);

const genericOps = [
  z.object({
    type: z.literal('replace_node'),
    nodeId,
    content: jsonContent,
    expect: nodeExpectation,
  }),
  z.object({
    type: z.literal('update_node_attrs'),
    nodeId,
    attrs: z.record(z.string(), z.any()),
    expect: nodeExpectation,
  }),
  z.object({
    type: z.literal('insert_before'),
    nodeId,
    content: jsonContentList,
    expect: nodeExpectation,
  }),
  z.object({
    type: z.literal('insert_after'),
    nodeId,
    content: jsonContentList,
    expect: nodeExpectation,
  }),
  z.object({
    type: z.literal('delete_node'),
    nodeId,
    expect: nodeExpectation,
  }),
];

const tableOps = [
  z.object({
    type: z.literal('set_table_cell'),
    tableId: nodeId,
    row: z.number().int().min(0),
    col: z.number().int().min(0),
    content: jsonContentList,
    expect: cellExpectation,
  }),
  z.object({
    type: z.literal('set_table_cell_attrs'),
    tableId: nodeId,
    row: z.number().int().min(0),
    col: z.number().int().min(0),
    attrs: z.record(z.string(), z.any()),
    expect: cellExpectation,
  }),
  z.object({
    type: z.literal('insert_table_row'),
    tableId: nodeId,
    at: z.number().int().min(0),
    cells: z.array(jsonContentList).optional(),
    header: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('delete_table_row'),
    tableId: nodeId,
    at: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('insert_table_column'),
    tableId: nodeId,
    at: z.number().int().min(0),
    cells: z.array(jsonContentList).optional(),
  }),
  z.object({
    type: z.literal('delete_table_column'),
    tableId: nodeId,
    at: z.number().int().min(0),
  }),
];

const databaseOps = [
  z.object({
    type: z.literal('set_database_cell'),
    databaseId: nodeId,
    rowId: z.string().min(1),
    columnId: z.string().min(1),
    value: z.any(),
    expect: z.object({ value: z.any() }).optional(),
  }),
  z.object({
    type: z.literal('insert_database_row'),
    databaseId: nodeId,
    values: z.record(z.string(), z.any()).optional(),
    beforeRowId: z.string().nullable().optional(),
    afterRowId: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal('delete_database_row'),
    databaseId: nodeId,
    rowId: z.string().min(1),
  }),
  z.object({
    type: z.literal('move_database_row'),
    databaseId: nodeId,
    rowId: z.string().min(1),
    beforeRowId: z.string().nullable(),
  }),
  z.object({
    type: z.literal('set_database_title'),
    databaseId: nodeId,
    title: z.string(),
  }),
  z.object({
    type: z.literal('add_database_column'),
    databaseId: nodeId,
    name: z.string().min(1),
    columnType: databaseColumnType,
    options: z.array(z.any()).optional(),
    anchorId: z.string().optional(),
    side: z.enum(['left', 'right']).optional(),
  }),
  z.object({
    type: z.literal('update_database_column'),
    databaseId: nodeId,
    columnId: z.string().min(1),
    name: z.string().optional(),
    options: z.array(z.any()).optional(),
    format: z.string().optional(),
    decimals: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('change_database_column_type'),
    databaseId: nodeId,
    columnId: z.string().min(1),
    columnType: databaseColumnType,
  }),
  z.object({
    type: z.literal('delete_database_column'),
    databaseId: nodeId,
    columnId: z.string().min(1),
  }),
  z.object({
    type: z.literal('add_database_view'),
    databaseId: nodeId,
    name: z.string().min(1),
    viewType: z.string().min(1),
  }),
  z.object({
    type: z.literal('update_database_view'),
    databaseId: nodeId,
    viewId: z.string().min(1),
    patch: z.record(z.string(), z.any()),
  }),
  z.object({
    type: z.literal('delete_database_view'),
    databaseId: nodeId,
    viewId: z.string().min(1),
  }),
  z.object({
    type: z.literal('move_database_view'),
    databaseId: nodeId,
    viewId: z.string().min(1),
    beforeViewId: z.string().nullable(),
  }),
];

export const editPageSchema = {
  pageId: z
    .string()
    .min(1)
    .describe('Page UUID or slug id obtained from another Tool.'),
  ops: z
    .array(z.union([...genericOps, ...tableOps, ...databaseOps] as any))
    .min(1)
    .max(EDIT_MAX_OPS)
    .describe(
      'Edit operations applied in order inside one transaction. All succeed or none are written.',
    ),
};
