import { Panel, Toc } from "@docmost/editor-ext";
import TocView from "@/features/editor/components/toc/toc-view.tsx";
import PanelView from "@/features/editor/components/panel/panel-view.tsx";

/**
 * Confluence-parity macro extensions, pre-configured with their React views.
 *
 * Adding a macro means appending one entry here. The only upstream touchpoint
 * is a single `...macroExtensions` spread in `extensions/extensions.ts`.
 */
export const macroExtensions = [
  Toc.configure({
    view: TocView,
  }),
  Panel.configure({
    view: PanelView,
  }),
];
