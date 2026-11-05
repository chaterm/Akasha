import type { Editor } from "@tiptap/core";
import { DOMSerializer, type Node as PMNode } from "@tiptap/pm/model";
import { htmlToMarkdown } from "@docmost/editor-ext";

export const isFocusWithinAiMenu = (
  relatedTarget: EventTarget | null,
  container: HTMLElement | null,
) =>
  relatedTarget instanceof Node && container?.contains(relatedTarget) === true;

export const AI_MENU_DROPDOWN_ATTR = "data-ai-menu-dropdown";

export const isOutsideAiMenu = (
  target: EventTarget | null,
  container: HTMLElement | null,
) =>
  target instanceof Element &&
  !container?.contains(target) &&
  !target.closest(`[${AI_MENU_DROPDOWN_ATTR}]`);

export const CURSOR_MARKER = "<!-- 光标位置 -->";
const MAX_PAGE_CONTEXT_CHARS = 60_000;
const MAX_HISTORY_TURNS = 10;
const MAX_HISTORY_MESSAGE_CHARS = 20_000;

export type AiTurn = { prompt: string; output: string };

function sliceToMarkdown(editor: Editor, doc: PMNode, from: number, to: number) {
  const serializer = DOMSerializer.fromSchema(editor.schema);
  const wrapper = document.createElement("div");
  wrapper.appendChild(serializer.serializeFragment(doc.slice(from, to).content));
  return htmlToMarkdown(wrapper.innerHTML).trim();
}

export function buildPageContext(editor: Editor): string {
  const { doc, selection } = editor.state;
  let before = sliceToMarkdown(editor, doc, 0, selection.from);
  let after = sliceToMarkdown(editor, doc, selection.from, doc.content.size);

  const budget = MAX_PAGE_CONTEXT_CHARS - CURSOR_MARKER.length - 4;
  if (before.length + after.length > budget) {
    const half = Math.floor(budget / 2);
    const keepBefore = Math.min(before.length, Math.max(half, budget - after.length));
    const keepAfter = budget - keepBefore;
    before = before.slice(before.length - keepBefore);
    after = after.slice(0, keepAfter);
  }

  return [before, CURSOR_MARKER, after].filter(Boolean).join("\n\n");
}

export function buildHistoryMessages(turns: AiTurn[]) {
  return turns.slice(-MAX_HISTORY_TURNS).flatMap(({ prompt, output }) => [
    { role: "user" as const, content: prompt.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
    {
      role: "assistant" as const,
      content: output.slice(0, MAX_HISTORY_MESSAGE_CHARS),
    },
  ]);
}
