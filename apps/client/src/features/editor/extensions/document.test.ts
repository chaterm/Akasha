import { readFileSync } from "node:fs";
import { Editor, Node } from "@tiptap/core";
import { GapCursor } from "@tiptap/pm/gapcursor";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { StarterKit } from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { TiptapDocument } from "./document";

const readStyle = (name: string) =>
  readFileSync(`src/features/editor/styles/${name}`, "utf8");

const Footnotes = Node.create({
  name: "footnotes",
  group: "",
  content: "paragraph*",
  isolating: true,
  renderHTML() {
    return ["ol", { class: "footnotes" }, 0];
  },
});

const DocumentWithTrailingNonTextblock = TiptapDocument.extend({
  content: "block+ footnotes?",
});

function mousedownAt(editor: Editor, clientY: number) {
  const event = new MouseEvent("mousedown", {
    clientY,
    button: 0,
    bubbles: true,
    cancelable: true,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

function stubRects(editor: Editor, editorTop: number, firstBlockTop: number) {
  editor.view.dom.getBoundingClientRect = () =>
    ({ top: editorTop }) as DOMRect;
  const first = editor.view.dom.firstElementChild as HTMLElement;
  first.getBoundingClientRect = () => ({ top: firstBlockTop }) as DOMRect;
}

const AtomBlock = Node.create({
  name: "atomBlock",
  group: "block",
  atom: true,
  renderHTML() {
    return ["div", { "data-atom-block": "" }];
  },
});

const IsolatingBlock = Node.create({
  name: "isolatingBlock",
  group: "block",
  content: "paragraph+",
  isolating: true,
  renderHTML() {
    return ["div", { "data-isolating-block": "" }, 0];
  },
});

function createEditor(content: object[]) {
  if (!document.elementFromPoint) {
    (document as never as { elementFromPoint: () => null }).elementFromPoint =
      () => null;
  }
  const element = document.createElement("div");
  document.body.appendChild(element);

  return new Editor({
    element,
    extensions: [
      DocumentWithTrailingNonTextblock,
      StarterKit.configure({ document: false }),
      Footnotes,
      AtomBlock,
      IsolatingBlock,
    ],
    content: { type: "doc", content },
  });
}

function pressKey(editor: Editor, key: string, keyCode: number) {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      keyCode,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function shape(editor: Editor) {
  const kids: string[] = [];
  editor.state.doc.forEach((node) => kids.push(node.type.name));
  return kids.join(",");
}

function backspaceAtDocStart(editor: Editor) {
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)),
  );
  pressKey(editor, "Backspace", 8);
}

describe("TiptapDocument leading Backspace", () => {
  it("removes an empty first paragraph that cannot join backward", () => {
    const editor = createEditor([{ type: "paragraph" }, { type: "atomBlock" }]);

    backspaceAtDocStart(editor);

    expect(editor.state.doc.child(0).type.name).toBe("atomBlock");

    editor.destroy();
  });

  it("keeps a first paragraph that still has text", () => {
    const editor = createEditor([
      { type: "paragraph", content: [{ type: "text", text: "hello" }] },
      { type: "atomBlock" },
    ]);

    backspaceAtDocStart(editor);

    expect(editor.state.doc.child(0).type.name).toBe("paragraph");
    expect(editor.state.doc.child(0).textContent).toBe("hello");
    expect(editor.state.doc.child(1).type.name).toBe("atomBlock");

    editor.destroy();
  });

  it("keeps the last remaining block", () => {
    const editor = createEditor([{ type: "paragraph" }]);

    backspaceAtDocStart(editor);

    expect(shape(editor)).toBe("paragraph");

    editor.destroy();
  });

  it("lets an empty first heading demote to a paragraph instead", () => {
    const editor = createEditor([
      { type: "heading", attrs: { level: 2 } },
      { type: "atomBlock" },
    ]);

    backspaceAtDocStart(editor);

    expect(editor.state.doc.child(0).type.name).toBe("paragraph");
    expect(editor.state.doc.childCount).toBeGreaterThanOrEqual(2);

    editor.destroy();
  });

  it("leaves a first block that wraps its own textblock alone", () => {
    const editor = createEditor([
      { type: "blockquote", content: [{ type: "paragraph" }] },
      { type: "paragraph" },
    ]);

    backspaceAtDocStart(editor);

    expect(shape(editor).startsWith("blockquote,paragraph")).toBe(true);

    editor.destroy();
  });
});

describe("TiptapDocument", () => {
  it("stops on the gap when arrowing down from a selected block node", () => {
    const editor = createEditor([
      { type: "atomBlock" },
      { type: "atomBlock" },
      { type: "paragraph" },
    ]);
    const gapPos = editor.state.doc.child(0).nodeSize;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        NodeSelection.create(editor.state.doc, 0),
      ),
    );

    pressKey(editor, "ArrowDown", 40);

    expect(editor.state.selection).toBeInstanceOf(GapCursor);
    expect(editor.state.selection.head).toBe(gapPos);

    editor.destroy();
  });

  it("places a gap cursor when clicking above a leading block node", () => {
    const editor = createEditor([
      { type: "atomBlock" },
      { type: "paragraph" },
    ]);
    stubRects(editor, 100, 112);

    const event = mousedownAt(editor, 105);

    expect(editor.state.selection).toBeInstanceOf(GapCursor);
    expect(editor.state.selection.head).toBe(0);
    expect(event.defaultPrevented).toBe(true);

    editor.destroy();
  });

  it("ships the stylesheet that makes a gap cursor visible", () => {
    expect(readStyle("index.css")).toContain('@import "./gap-cursor.css"');

    const css = readStyle("gap-cursor.css");
    expect(css).toContain(".ProseMirror-focused .ProseMirror-gapcursor");
    expect(css).toMatch(/\.ProseMirror-gapcursor::after[\s\S]*border-top:/);
  });

  it("renders the placed gap cursor", () => {
    const editor = createEditor([
      { type: "atomBlock" },
      { type: "paragraph" },
    ]);
    stubRects(editor, 100, 112);

    mousedownAt(editor, 105);

    expect(editor.view.dom.querySelector(".ProseMirror-gapcursor")).not.toBeNull();

    editor.destroy();
  });

  it("leaves a leading textblock to the normal text cursor", () => {
    const editor = createEditor([
      { type: "paragraph", content: [{ type: "text", text: "hi" }] },
    ]);
    stubRects(editor, 100, 112);

    const event = mousedownAt(editor, 105);

    expect(editor.state.selection).not.toBeInstanceOf(GapCursor);
    expect(event.defaultPrevented).toBe(false);

    editor.destroy();
  });

  it("leaves clicks on the first block itself alone", () => {
    const editor = createEditor([
      { type: "atomBlock" },
      { type: "paragraph" },
    ]);
    stubRects(editor, 100, 112);
    const before = editor.state.selection;

    const event = mousedownAt(editor, 130);

    expect(editor.state.selection).toBe(before);
    expect(event.defaultPrevented).toBe(false);

    editor.destroy();
  });

  it("stops on the gap when arrowing right out of an isolating block", () => {
    const paragraph = (text: string) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    });
    const editor = createEditor([
      { type: "isolatingBlock", content: [paragraph("a")] },
      { type: "isolatingBlock", content: [paragraph("b")] },
      { type: "paragraph" },
    ]);
    const gapPos = editor.state.doc.child(0).nodeSize;
    const endOfFirstText = gapPos - 2;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, endOfFirstText),
      ),
    );

    pressKey(editor, "ArrowRight", 39);

    expect(editor.state.selection).toBeInstanceOf(GapCursor);
    expect(editor.state.selection.head).toBe(gapPos);

    editor.destroy();
  });
});
