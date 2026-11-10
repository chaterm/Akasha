import { describe, expect, it, vi } from "vitest";
import { applyTemplateToEditor } from "./apply-template";

const makeEditor = (isEmpty: boolean) => {
  const run = vi.fn();
  const insertContent = vi.fn(() => ({ run }));
  const focus = vi.fn(() => ({ insertContent }));
  return {
    isEmpty,
    commands: { setContent: vi.fn() },
    chain: vi.fn(() => ({ focus })),
    _insertContent: insertContent,
    _run: run,
  } as any;
};

const template = {
  title: "周报",
  content: { type: "doc", content: [{ type: "paragraph" }] },
};

describe("applyTemplateToEditor", () => {
  it("空页面：替换正文，并在标题为空时填入模板标题", () => {
    const editor = makeEditor(true);
    const title = makeEditor(true);
    expect(applyTemplateToEditor(editor, title, template)).toBe("replaced");
    expect(editor.commands.setContent).toHaveBeenCalledWith(template.content, {
      emitUpdate: true,
    });
    expect(title.commands.setContent).toHaveBeenCalledWith("周报", {
      emitUpdate: true,
    });
  });

  it("空页面但已有标题：不覆盖标题", () => {
    const title = makeEditor(false);
    applyTemplateToEditor(makeEditor(true), title, template);
    expect(title.commands.setContent).not.toHaveBeenCalled();
  });

  it("非空页面：在光标处插入模板块，不动标题", () => {
    const editor = makeEditor(false);
    const title = makeEditor(true);
    expect(applyTemplateToEditor(editor, title, template)).toBe("inserted");
    expect(editor._insertContent).toHaveBeenCalledWith(
      template.content.content,
    );
    expect(editor._run).toHaveBeenCalled();
    expect(editor.commands.setContent).not.toHaveBeenCalled();
    expect(title.commands.setContent).not.toHaveBeenCalled();
  });
});
