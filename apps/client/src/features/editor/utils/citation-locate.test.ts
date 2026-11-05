import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, Node, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  citationAnchorBlock,
  findCitationRange,
  pickDocCitationQuote,
  scrollToCitation,
} from "./citation-locate";

const PageRef = Node.create({
  name: "pageRef",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes: () => ({ label: { default: "" } }),
  renderHTML: ({ node }) => ["span", node.attrs.label],
  renderText: ({ node }) => `@${node.attrs.label}`,
});

const Figure = Node.create({
  name: "figure",
  group: "block",
  atom: true,
  addAttributes: () => ({ attachmentId: { default: null } }),
  renderHTML: () => ["figure"],
});

const editors: Editor[] = [];
afterEach(() =>
  editors.splice(0).forEach((editor) => {
    editor.view.dom.parentElement?.remove();
    editor.destroy();
  }),
);

const p = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const h = (text: string): JSONContent => ({
  type: "heading",
  attrs: { level: 2 },
  content: [{ type: "text", text }],
});

function createEditor(content: JSONContent[]) {
  const editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [StarterKit, PageRef, Figure],
    content: { type: "doc", content },
  });
  editors.push(editor);
  return editor;
}

function textOf(editor: Editor, range: { from: number; to: number }) {
  return editor.state.doc.textBetween(range.from, range.to, "\n", (node) =>
    node.type.name === "pageRef" ? `@${node.attrs.label}` : "",
  );
}

describe("findCitationRange", () => {
  it("忽略空白和标点，跨段落定位片段", () => {
    const editor = createEditor([
      p("开头无关内容。"),
      p("部署前需要先备份数据库，"),
      p("然后执行迁移脚本。"),
    ]);

    const range = findCitationRange(editor.state.doc, {
      start: "部署前需要先备份数据库然后执行迁移脚本",
    });

    expect(textOf(editor, range!)).toBe(
      "部署前需要先备份数据库，\n然后执行迁移脚本",
    );
  });

  it("片段里有编辑器中不存在的文字时，用首尾锚点定位", () => {
    const editor = createEditor([
      p("Intro paragraph."),
      p(
        "The rollout starts with the staging cluster and then moves to production after review.",
      ),
    ]);

    const range = findCitationRange(editor.state.doc, {
      start:
        "Therolloutstartswiththestagingclusterattachmentplanpdfandthenmovestoproductionafterreview",
    });

    expect(textOf(editor, range!)).toBe(
      "The rollout starts with the staging cluster and then moves to production after review",
    );
  });

  it("首段重复出现时，取离尾段最近的那一次", () => {
    const editor = createEditor([
      p("解决方案：进入打印设置，关闭提示音。"),
      p("解决方案：进入打印设置，开启自动双面。"),
    ]);

    const range = findCitationRange(editor.state.doc, {
      start: "解决方案进入打印设置",
      end: "开启自动双面",
    });

    expect(textOf(editor, range!)).toBe("解决方案：进入打印设置，开启自动双面");
  });

  it("能定位页面引用这类只有属性文字的节点", () => {
    const editor = createEditor([
      {
        type: "paragraph",
        content: [{ type: "pageRef", attrs: { label: "部署手册" } }],
      },
    ]);

    const range = findCitationRange(editor.state.doc, {
      start: "部署手册",
    });

    expect(textOf(editor, range!)).toBe("@部署手册");
  });

  it("按附件 ID 定位图片", () => {
    const editor = createEditor([
      p("开头"),
      { type: "figure", attrs: { attachmentId: "a-1" } },
      { type: "figure", attrs: { attachmentId: "a-2" } },
    ]);

    const range = findCitationRange(editor.state.doc, { attachmentId: "a-2" });

    expect(editor.state.doc.nodeAt(range!.from)?.attrs.attachmentId).toBe(
      "a-2",
    );
  });

  it("找不到时返回 null", () => {
    const editor = createEditor([p("Nothing relevant here.")]);
    expect(
      findCitationRange(editor.state.doc, { start: "missingquote" }),
    ).toBeNull();
  });
});

describe("pickDocCitationQuote", () => {
  it("没有摘录时在文档段落里找包含提问的位置", () => {
    const editor = createEditor([
      h("打印助手 常见问题20"),
      p("说明：如何开启省墨模式。"),
      p("解决方案：进入打印设置选择草稿质量后，点击上方的省墨图示。"),
      h("打印助手 常见问题21"),
      p("说明：如何重新打印。"),
      p("解决方案：进入打印队列选择已完成任务后，点击“重新打印”进行重打。"),
    ]);
    const { doc } = editor.state;

    const quote = pickDocCitationQuote(
      doc,
      "重新打印的操作步骤如下：进入打印队列选择已完成任务后，点击“重新打印”即可进行重打。",
      "如何重新打印",
    );
    const range = findCitationRange(doc, quote!);

    expect(doc.nodeAt(citationAnchorBlock(doc, range!.from).pos)?.textContent).toBe(
      "打印助手 常见问题21",
    );
  });
});

describe("citationAnchorBlock", () => {
  it("片段紧跟在标题后面时定位到标题", () => {
    const editor = createEditor([
      p("开头"),
      h("打印助手 常见问题3"),
      p("说明：打印内容偏移。"),
      p("解决方案：联系支持。"),
    ]);
    const range = findCitationRange(editor.state.doc, { start: "解决方案联系支持" });

    const anchor = citationAnchorBlock(editor.state.doc, range!.from);

    expect(anchor.isHeading).toBe(true);
    expect(editor.state.doc.nodeAt(anchor.pos)?.textContent).toBe(
      "打印助手 常见问题3",
    );
  });

  it("和标题之间隔着图片或太远时定位到片段所在段落", () => {
    const editor = createEditor([
      h("标题"),
      { type: "figure" },
      p("片段所在段落"),
    ]);
    const range = findCitationRange(editor.state.doc, { start: "片段所在段落" });

    const anchor = citationAnchorBlock(editor.state.doc, range!.from);

    expect(anchor.isHeading).toBe(false);
    expect(editor.state.doc.nodeAt(anchor.pos)?.textContent).toBe(
      "片段所在段落",
    );
  });
});

describe("scrollToCitation", () => {
  it("标题滚到顶部，普通段落滚到中间", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const editor = createEditor([h("标题"), p("正文"), { type: "figure" }, p("远处")]);

    const near = findCitationRange(editor.state.doc, { start: "正文" })!;
    scrollToCitation(editor.view, near)();
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "start" });

    const far = findCitationRange(editor.state.doc, { start: "远处" })!;
    scrollToCitation(editor.view, far)();
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "center" });
    expect((scrollIntoView.mock.contexts.at(-1) as Element).textContent).toBe(
      "远处",
    );
  });
});
