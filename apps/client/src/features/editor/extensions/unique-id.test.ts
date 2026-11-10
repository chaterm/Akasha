import { afterEach, describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Fragment, Slice } from "@tiptap/pm/model";
import { UniqueID, fillSliceIds } from "@docmost/editor-ext";
import { MarkdownClipboard } from "./markdown-clipboard";

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

function createEditor(content: JSONContent[]) {
  const editor = new Editor({
    extensions: [
      StarterKit,
      UniqueID.configure({ types: ["heading", "paragraph"] }),
    ],
    content: { type: "doc", content },
  });
  editors.push(editor);
  return editor;
}

const paragraph = (text: string, id?: string): JSONContent => ({
  type: "paragraph",
  ...(id ? { attrs: { id } } : {}),
  content: [{ type: "text", text }],
});

const paragraphs = (count: number) =>
  Array.from({ length: count }, (_, i) => paragraph(`line ${i}`));

const blockIds = (editor: Editor) => {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "paragraph" || node.type.name === "heading") {
      ids.push(node.attrs.id);
    }
  });
  return ids;
};

const expectUniqueIds = (ids: string[]) => {
  ids.forEach((id) => expect(id).toEqual(expect.any(String)));
  expect(new Set(ids).size).toBe(ids.length);
};

const uniqueIdPlugin = (editor: Editor) =>
  editor.state.plugins.find((plugin) =>
    (plugin as unknown as { key: string }).key.startsWith("uniqueID$"),
  )!;

describe("UniqueID", () => {
  it("gives every inserted block a unique id", () => {
    const editor = createEditor([paragraph("first", "first-id")]);

    editor.commands.insertContent(paragraphs(50));

    expectUniqueIds(blockIds(editor));
  });

  it("writes fresh ids into pasted content so no follow-up step is needed", () => {
    const editor = createEditor([
      paragraph("a", "a-id"),
      paragraph("b", "b-id"),
    ]);
    const plugin = uniqueIdPlugin(editor);
    const { schema } = editor;
    const copied = new Slice(
      Fragment.from([
        schema.nodeFromJSON(paragraph("a", "a-id")),
        schema.nodeFromJSON(paragraph("b", "b-id")),
      ]),
      0,
      0,
    );

    plugin.props.handleDOMEvents!.paste!.call(
      plugin,
      editor.view,
      new Event("paste") as ClipboardEvent,
    );
    const pasted = plugin.props.transformPasted!.call(
      plugin,
      copied,
      editor.view,
    );
    const pastedIds: string[] = [];
    pasted.content.forEach((node) => pastedIds.push(node.attrs.id));
    expect(pastedIds).not.toContain("a-id");
    expect(pastedIds).not.toContain("b-id");

    const appended: string[] = [];
    editor.on("transaction", ({ appendedTransactions }) => {
      appendedTransactions.forEach((tr) => {
        if (tr.getMeta("__uniqueIDTransaction")) appended.push("uniqueID");
      });
    });
    editor.view.dispatch(
      editor.state.tr.insert(editor.state.doc.content.size, pasted.content),
    );

    expect(appended).toEqual([]);
    expectUniqueIds(blockIds(editor));
  });

  it("resolves ids duplicated by inserted content", () => {
    const editor = createEditor([paragraph("a", "dup")]);

    editor.commands.insertContentAt(editor.state.doc.content.size, [
      paragraph("b", "dup"),
      paragraph("c", "dup"),
    ]);

    const ids = blockIds(editor);
    expect(ids[0]).toBe("dup");
    expectUniqueIds(ids);
  });

  it("keeps the id with the text when a block is split at its start", () => {
    const editor = createEditor([paragraph("hello", "keep")]);

    editor.chain().setTextSelection(1).splitBlock().run();

    const ids = blockIds(editor);
    expect(ids[1]).toBe("keep");
    expectUniqueIds(ids);
  });

  it("keeps the id on the first block when a block is split at its end", () => {
    const editor = createEditor([paragraph("hello", "keep")]);

    editor.chain().setTextSelection(6).splitBlock().run();

    const ids = blockIds(editor);
    expect(ids[0]).toBe("keep");
    expectUniqueIds(ids);
  });

  it("assigns ids to a large insert in linear time", () => {
    const editor = createEditor([paragraph("first", "first-id")]);
    const nodes = paragraphs(4000).map((json) =>
      editor.schema.nodeFromJSON(json),
    );
    const tr = editor.state.tr.insert(editor.state.doc.content.size, nodes);

    const started = performance.now();
    const { state } = editor.state.applyTransaction(tr);
    const elapsed = performance.now() - started;

    const ids: string[] = [];
    state.doc.forEach((node) => ids.push(node.attrs.id));
    expect(ids).toHaveLength(4001);
    expectUniqueIds(ids);
    expect(elapsed).toBeLessThan(1000);
  });

  it("keeps the selection when ids are assigned in bulk", () => {
    const editor = createEditor([paragraph("first", "first-id")]);
    editor.commands.setTextSelection(3);

    editor.commands.insertContentAt(
      editor.state.doc.content.size,
      paragraphs(200),
      { updateSelection: false },
    );

    expect(editor.state.selection.from).toBe(3);
    expectUniqueIds(blockIds(editor));
  });
});

describe("UniqueID with markdown paste", () => {
  it("pastes markdown without a follow-up step per block", () => {
    const editor = new Editor({
      extensions: [
        StarterKit,
        UniqueID.configure({ types: ["heading", "paragraph"] }),
        MarkdownClipboard.configure({ transformPastedText: true }),
      ],
      content: { type: "doc", content: [paragraph("first", "first-id")] },
    });
    editors.push(editor);
    const appendedSteps: string[] = [];
    editor.on("transaction", ({ appendedTransactions }) => {
      appendedTransactions
        .filter((tr) => tr.getMeta("__uniqueIDTransaction"))
        .forEach((tr) =>
          tr.steps.forEach((step) =>
            appendedSteps.push(step.toJSON().stepType),
          ),
        );
    });
    const markdown = Array.from({ length: 300 }, (_, i) => `line ${i}`).join(
      "\n\n",
    );
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        getData: (type: string) => (type === "text/plain" ? markdown : ""),
        files: [],
        types: ["text/plain"],
      },
    });

    editor.view.dom.dispatchEvent(event);

    const ids = blockIds(editor);
    expect(ids).toHaveLength(300);
    expectUniqueIds(ids);
    expect(appendedSteps.length).toBeLessThanOrEqual(2);
    expect(appendedSteps).not.toContain("replace");
  });
});

describe("fillSliceIds", () => {
  it("fills missing ids at any depth and keeps existing ones", () => {
    const editor = createEditor([paragraph("x")]);
    const slice = new Slice(
      Fragment.from([
        editor.schema.nodeFromJSON(paragraph("kept", "kept-id")),
        editor.schema.nodeFromJSON({
          type: "bulletList",
          content: [{ type: "listItem", content: [paragraph("nested")] }],
        }),
      ]),
      0,
      0,
    );

    const filled = fillSliceIds(slice, {
      types: ["paragraph"],
      attributeName: "id",
      generateID: () => `gen-${Math.random()}`,
    });

    expect(filled.content.child(0).attrs.id).toBe("kept-id");
    expect(filled.content.child(1).firstChild!.firstChild!.attrs.id).toMatch(
      /^gen-/,
    );
    expect(filled.openStart).toBe(0);
  });
});
