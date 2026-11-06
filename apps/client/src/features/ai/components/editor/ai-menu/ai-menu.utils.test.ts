import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  AI_MENU_DROPDOWN_ATTR,
  CURSOR_MARKER,
  buildHistoryMessages,
  buildPageContext,
  isFocusWithinAiMenu,
  isOutsideAiMenu,
} from "./ai-menu.utils";

describe("isFocusWithinAiMenu", () => {
  it("keeps the AI menu open when its prompt receives focus", () => {
    const container = document.createElement("div");
    const input = document.createElement("input");
    container.appendChild(input);

    expect(isFocusWithinAiMenu(input, container)).toBe(true);
  });

  it("allows the AI menu to close when focus moves elsewhere", () => {
    const container = document.createElement("div");
    const outsideButton = document.createElement("button");

    expect(isFocusWithinAiMenu(outsideButton, container)).toBe(false);
    expect(isFocusWithinAiMenu(null, container)).toBe(false);
  });
});

describe("isOutsideAiMenu", () => {
  it("closes for clicks outside the menu but not on its command list", () => {
    const container = document.createElement("div");
    const input = document.createElement("input");
    container.appendChild(input);
    const dropdown = document.createElement("div");
    dropdown.setAttribute(AI_MENU_DROPDOWN_ATTR, "true");
    const item = document.createElement("button");
    dropdown.appendChild(item);
    const pageText = document.createElement("p");

    expect(isOutsideAiMenu(input, container)).toBe(false);
    expect(isOutsideAiMenu(item, container)).toBe(false);
    expect(isOutsideAiMenu(pageText, container)).toBe(true);
  });
});

describe("buildPageContext", () => {
  const editors: Editor[] = [];
  afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

  function createEditor(html: string) {
    const editor = new Editor({ extensions: [StarterKit], content: html });
    editors.push(editor);
    return editor;
  }

  it("marks the cursor position inside the page markdown", () => {
    const editor = createEditor("<h2>周会</h2><p>议题一</p><p>议题二</p>");
    let end = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.textContent === "议题一" && node.isTextblock)
        end = pos + node.nodeSize - 1;
    });
    editor.commands.setTextSelection(end);

    const context = buildPageContext(editor);

    expect(context).toMatch(
      /## 周会[\s\S]*议题一[\s\S]*<!-- 光标位置 -->[\s\S]*议题二/,
    );
    expect(context.split(CURSOR_MARKER)).toHaveLength(2);
  });

  it("keeps the text around the cursor when the page is too long", () => {
    const paragraphs = Array.from(
      { length: 8000 },
      (_, i) => `<p>第${i}段内容内容内容</p>`,
    );
    const editor = createEditor(paragraphs.join(""));
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    const context = buildPageContext(editor);

    expect(context.length).toBeLessThanOrEqual(60_000);
    expect(context).toContain("第7999段");
    expect(context.startsWith("第0段")).toBe(false);
    expect(context).toContain(CURSOR_MARKER);
  }, 15_000);
});

describe("buildHistoryMessages", () => {
  it("turns earlier rounds into alternating user and assistant messages", () => {
    expect(
      buildHistoryMessages([
        { prompt: "列个表格", output: "| a |" },
        { prompt: "加一列", output: "| a | b |" },
      ]),
    ).toEqual([
      { role: "user", content: "列个表格" },
      { role: "assistant", content: "| a |" },
      { role: "user", content: "加一列" },
      { role: "assistant", content: "| a | b |" },
    ]);
  });

  it("keeps only the latest ten rounds", () => {
    const turns = Array.from({ length: 12 }, (_, i) => ({
      prompt: `问${i}`,
      output: `答${i}`,
    }));

    const messages = buildHistoryMessages(turns);

    expect(messages).toHaveLength(20);
    expect(messages[0]).toEqual({ role: "user", content: "问2" });
  });
});
