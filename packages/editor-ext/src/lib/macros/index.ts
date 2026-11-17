export * from './toc';
export * from './panel';
export * from './database';

import { Toc } from './toc';
import { Panel } from './panel';
import { Database, DatabaseCell, DatabaseRow } from './database';

export const macroNodesWithoutView = [DatabaseRow, DatabaseCell] as const;

export const macroNodesWithView = [Toc, Panel, Database] as const;

export const macroNodes = [
  ...macroNodesWithoutView,
  ...macroNodesWithView,
] as const;
