import type { JSONContent } from '@tiptap/core';

export type NodeExpectation = {
  nodeType?: string;
  textContent?: string;
  attrs?: Record<string, unknown>;
};

export type CellExpectation = {
  textContent?: string;
};

export type DatabaseCellExpectation = {
  value?: unknown;
};

export type DatabaseColumnType =
  | 'text'
  | 'number'
  | 'select'
  | 'multiSelect'
  | 'date'
  | 'checkbox'
  | 'person'
  | 'url';

export type GenericEditOp =
  | {
      type: 'replace_node';
      nodeId: string;
      content: JSONContent;
      expect?: NodeExpectation;
    }
  | {
      type: 'update_node_attrs';
      nodeId: string;
      attrs: Record<string, unknown>;
      expect?: NodeExpectation;
    }
  | {
      type: 'insert_before' | 'insert_after';
      nodeId: string;
      content: JSONContent[];
      expect?: NodeExpectation;
    }
  | {
      type: 'delete_node';
      nodeId: string;
      expect?: NodeExpectation;
    };

export type TableEditOp =
  | {
      type: 'set_table_cell';
      tableId: string;
      row: number;
      col: number;
      content: JSONContent[];
      expect?: CellExpectation;
    }
  | {
      type: 'set_table_cell_attrs';
      tableId: string;
      row: number;
      col: number;
      attrs: Record<string, unknown>;
      expect?: CellExpectation;
    }
  | {
      type: 'insert_table_row';
      tableId: string;
      at: number;
      cells?: JSONContent[][];
      header?: boolean;
    }
  | {
      type: 'delete_table_row';
      tableId: string;
      at: number;
    }
  | {
      type: 'insert_table_column';
      tableId: string;
      at: number;
      cells?: JSONContent[][];
    }
  | {
      type: 'delete_table_column';
      tableId: string;
      at: number;
    };

export type DatabaseEditOp =
  | {
      type: 'set_database_cell';
      databaseId: string;
      rowId: string;
      columnId: string;
      value: unknown;
      expect?: DatabaseCellExpectation;
    }
  | {
      type: 'insert_database_row';
      databaseId: string;
      values?: Record<string, unknown>;
      beforeRowId?: string | null;
      afterRowId?: string | null;
    }
  | {
      type: 'delete_database_row';
      databaseId: string;
      rowId: string;
    }
  | {
      type: 'move_database_row';
      databaseId: string;
      rowId: string;
      beforeRowId: string | null;
    }
  | {
      type: 'set_database_title';
      databaseId: string;
      title: string;
    }
  | {
      type: 'add_database_column';
      databaseId: string;
      name: string;
      columnType: DatabaseColumnType;
      options?: unknown[];
      anchorId?: string;
      side?: 'left' | 'right';
    }
  | {
      type: 'update_database_column';
      databaseId: string;
      columnId: string;
      name?: string;
      options?: unknown[];
      format?: string;
      decimals?: number;
    }
  | {
      type: 'change_database_column_type';
      databaseId: string;
      columnId: string;
      columnType: DatabaseColumnType;
    }
  | {
      type: 'delete_database_column';
      databaseId: string;
      columnId: string;
    }
  | {
      type: 'add_database_view';
      databaseId: string;
      name: string;
      viewType: string;
    }
  | {
      type: 'update_database_view';
      databaseId: string;
      viewId: string;
      patch: Record<string, unknown>;
    }
  | {
      type: 'delete_database_view';
      databaseId: string;
      viewId: string;
    }
  | {
      type: 'move_database_view';
      databaseId: string;
      viewId: string;
      beforeViewId: string | null;
    };

export type PageEditOp = GenericEditOp | TableEditOp | DatabaseEditOp;

export type PageEditOutcome = {
  index: number;
  type: PageEditOp['type'];
  createdId?: string;
};
