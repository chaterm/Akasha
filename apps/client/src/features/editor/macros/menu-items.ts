import { IconDatabase, IconList, IconLayoutGrid } from "@tabler/icons-react";
import { insertDefaultDatabase } from "./insert-database";
import {
  CommandProps,
  SlashMenuItemType,
} from "@/features/editor/components/slash-menu/types";

export const macroMenuItems: SlashMenuItemType[] = [
  {
    title: "Table of contents",
    shortcut: "toc",
    description: "Insert an outline of this page's headings",
    searchTerms: ["toc", "table of contents", "outline", "contents", "index"],
    icon: IconList,
    command: ({ editor, range }: CommandProps) => {
      editor.chain().focus().deleteRange(range).insertToc().run();
    },
  },
  {
    title: "Panel",
    shortcut: "panel",
    description: "Insert a neutral content panel.",
    searchTerms: ["panel", "container", "box", "section"],
    icon: IconLayoutGrid,
    command: ({ editor, range }: CommandProps) => {
      editor.chain().focus().deleteRange(range).insertPanel().run();
    },
  },
  {
    title: "Database",
    shortcut: "database",
    description:
      "Insert a database with table, kanban, calendar and timeline views.",
    searchTerms: ["database", "kanban", "board", "calendar", "table view"],
    icon: IconDatabase,
    command: ({ editor, range }: CommandProps) =>
      insertDefaultDatabase(editor, range),
  },
];
