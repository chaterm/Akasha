import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import { ContentStats, measureDoc } from "../page-split.utils";

const EMPTY: ContentStats = { imageCount: 0, bytes: 0, words: 0 };

/** 编辑后防抖更新。 */
export function usePageContentStats(editor: Editor | null): ContentStats {
  const [stats, setStats] = useState(() =>
    editor ? measureDoc(editor.state.doc) : EMPTY,
  );

  useEffect(() => {
    if (!editor) {
      setStats(EMPTY);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (!editor.isDestroyed) setStats(measureDoc(editor.state.doc));
    };
    const scheduleUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(update, 500);
    };
    update();
    editor.on("update", scheduleUpdate);
    return () => {
      clearTimeout(timer);
      editor.off("update", scheduleUpdate);
    };
  }, [editor]);

  return stats;
}
