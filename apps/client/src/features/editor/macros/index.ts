import {
  Database,
  macroNodesWithoutView,
  Panel,
  Toc,
} from "@docmost/editor-ext";
import TocView from "@/features/editor/components/toc/toc-view.tsx";
import PanelView from "@/features/editor/components/panel/panel-view.tsx";
import DatabaseView from "@/features/editor/components/database/database-view.tsx";

export const macroExtensions = [
  Toc.configure({
    view: TocView,
  }),
  Panel.configure({
    view: PanelView,
  }),
  Database.configure({
    view: DatabaseView,
  }),
  ...macroNodesWithoutView,
];
