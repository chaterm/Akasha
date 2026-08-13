import { IconList, IconLayoutGrid } from "@tabler/icons-react";
import {
  CommandProps,
  SlashMenuItemType,
} from "@/features/editor/components/slash-menu/types";

/**
 * Slash-menu entries for Confluence-parity macros.
 *
 * Adding a macro means appending one entry here. The only upstream touchpoint
 * is a single `...macroMenuItems` spread in
 * `components/slash-menu/menu-items.ts`.
 *
 * `title`/`description` are i18n keys resolved by the upstream menu via
 * `t(item.title)` on the default namespace, so they still live in
 * `translation.json`. That file is high-churn but upstream only ever appends
 * keys, so conflicts are one-line and trivial to resolve.
 */
export const macroMenuItems: SlashMenuItemType[] = [
  {
    title: "Table of contents",
    description: "Insert an outline of this page's headings",
    searchTerms: ["toc", "table of contents", "outline", "contents", "index"],
    icon: IconList,
    command: ({ editor, range }: CommandProps) => {
      editor.chain().focus().deleteRange(range).insertToc().run();
    },
  },
  {
    title: "Panel",
    description: "Insert a neutral content panel.",
    searchTerms: ["panel", "container", "box", "section"],
    icon: IconLayoutGrid,
    command: ({ editor, range }: CommandProps) => {
      editor.chain().focus().deleteRange(range).insertPanel().run();
    },
  },
];
