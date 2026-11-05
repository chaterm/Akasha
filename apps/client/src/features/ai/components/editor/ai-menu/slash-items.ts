import type { Editor } from "@tiptap/react";
import { getSuggestionItems } from "@/features/editor/components/slash-menu/menu-items";
import type { CommandItem } from "./command-items";

const ASK_AI_SHORTCUT = "ai";

export function getSlashCommandItems(
  prompt: string,
  editor: Editor | null,
): CommandItem[] | null {
  if (!prompt.startsWith("/")) return null;
  const query = prompt.slice(1).trim();
  return Object.values(
    getSuggestionItems({ query, editor: editor ?? undefined }),
  )
    .flat()
    .filter((item) => item.shortcut !== ASK_AI_SHORTCUT)
    .map((item) => ({
      id: `slash-${item.shortcut}`,
      name: item.title,
      icon: item.icon,
      slashItem: item,
    }));
}
