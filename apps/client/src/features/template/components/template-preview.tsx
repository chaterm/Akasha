import "@/features/editor/styles/index.css";
import { useEffect, useMemo } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { JSONContent } from "@tiptap/core";
import { UniqueID } from "@docmost/editor-ext";
import { mainExtensions } from "@/features/editor/extensions/extensions";
import { TransclusionLookupProvider } from "@/features/editor/components/transclusion/transclusion-lookup-context";

interface TemplatePreviewProps {
  content: JSONContent | undefined;
}

/** 只读渲染模板正文；不写入任何全局编辑器 atom，可同时存在多个实例。 */
export function TemplatePreview({ content }: TemplatePreviewProps) {
  const extensions = useMemo(
    () => [
      ...mainExtensions.filter((ext: any) => ext.name !== "uniqueID"),
      UniqueID.configure({
        types: ["heading", "paragraph"],
        updateDocument: false,
      }),
    ],
    [],
  );

  const editor = useEditor({
    editable: false,
    immediatelyRender: true,
    extensions,
    content: content ?? "",
  });

  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.commands.setContent(content ?? "", { emitUpdate: false });
    }
  }, [editor, content]);

  return (
    <TransclusionLookupProvider>
      <EditorContent editor={editor} />
    </TransclusionLookupProvider>
  );
}
