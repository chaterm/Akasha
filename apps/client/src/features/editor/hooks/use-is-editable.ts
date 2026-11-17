import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";

export function useIsEditable(editor: Editor | null | undefined): boolean {
  const [isEditable, setIsEditable] = useState(
    () => editor?.isEditable ?? false,
  );

  useEffect(() => {
    if (!editor) {
      setIsEditable(false);
      return;
    }

    const sync = () => setIsEditable(editor.isEditable);
    sync();

    editor.on("update", sync);
    editor.on("transaction", sync);
    return () => {
      editor.off("update", sync);
      editor.off("transaction", sync);
    };
  }, [editor]);

  return isEditable;
}
