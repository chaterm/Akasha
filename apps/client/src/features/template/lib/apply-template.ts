import { Editor, JSONContent } from "@tiptap/core";

/**
 * 把模板正文放进当前页面编辑器：
 * - 页面为空：整体替换，并在标题为空时带上模板标题；
 * - 页面非空：在光标处插入模板正文。
 */
export function applyTemplateToEditor(
  editor: Editor,
  titleEditor: Editor | null,
  template: { title?: string | null; content?: JSONContent },
): "replaced" | "inserted" {
  const body = template.content?.content ?? [];

  if (editor.isEmpty) {
    editor.commands.setContent(template.content ?? "", { emitUpdate: true });
    if (titleEditor && titleEditor.isEmpty && template.title) {
      titleEditor.commands.setContent(template.title, { emitUpdate: true });
    }
    return "replaced";
  }

  editor.chain().focus().insertContent(body).run();
  return "inserted";
}
