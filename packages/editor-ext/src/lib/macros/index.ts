export * from './toc';
export * from './panel';
export * from './database';
export * from './file-list';

import { Toc } from './toc';
import { Panel } from './panel';
import { Database, DatabaseCell, DatabaseRow } from './database';
import { FileList } from './file-list';

export const macroNodesWithoutView = [DatabaseRow, DatabaseCell] as const;

export const macroNodesWithView = [Toc, Panel, Database, FileList] as const;

export const macroNodes = [
  ...macroNodesWithoutView,
  ...macroNodesWithView,
] as const;
