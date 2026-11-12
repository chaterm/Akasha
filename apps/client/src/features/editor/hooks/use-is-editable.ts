import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";

/**
 * Tracks `editor.isEditable` across edit-mode switches.
 *
 * `useEditorState` would be the natural choice, but on @tiptap/react 3.20.4 it
 * does not re-evaluate when `setEditable` runs — the editor's own `isEditable`
 * flips correctly while the hook keeps returning the old value. `setEditable`
 * does emit `update`, so subscribing to it directly works on this version.
 */
export function useIsEditable(editor: Editor | null | undefined): boolean {
  const [isEditable, setIsEditable] = useState(() => editor?.isEditable ?? false);

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
