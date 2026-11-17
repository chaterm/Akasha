import { Editor, JSONContent } from "@tiptap/core";

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
