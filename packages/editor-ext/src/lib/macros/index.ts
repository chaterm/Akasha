/**
 * Confluence-parity macro registry.
 *
 * Everything under `lib/macros/` is Akasha-local — it does not exist upstream
 * in Docmost. Adding a macro means creating a folder here and appending to the
 * lists below; no upstream file changes.
 *
 * The single upstream touchpoint is one `export * from "./lib/macros"` line in
 * `packages/editor-ext/src/index.ts`.
 */
export * from './toc';
export * from './panel';

import { Toc } from './toc';
import { Panel } from './panel';

/**
 * Nodes with no NodeView, safe to register as-is on both client and server.
 */
export const macroNodesWithoutView = [] as const;

/**
 * Nodes requiring a React NodeView. The client pairs each with its view via
 * `.configure({ view })`; the server registers the bare node so the schema
 * matches (a mismatch silently drops content).
 */
export const macroNodesWithView = [Toc, Panel] as const;

/**
 * Every macro node, view or not. Used by the server, which never has views.
 */
export const macroNodes = [
  ...macroNodesWithoutView,
  ...macroNodesWithView,
] as const;
