import "@/features/editor/styles/index.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { mainExtensions } from "@/features/editor/extensions/extensions";
import { Title } from "@mantine/core";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import historyClasses from "./css/history.module.css";
import { DOMSerializer, Node, Schema } from "@tiptap/pm/model";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  DiffCounts,
  diffCountsAtom,
  diffStateAtom,
  highlightChangesAtom,
} from "@/features/page-history/atoms/history-atoms";
import type { DiffChange } from "@/features/page-history/workers/diff.worker";
import { IPageHistoryDiff } from "@/features/page-history/types/page.types";
import { computeTitleDiff } from "@/features/page-history/utils/title-diff";

export interface HistoryEditorProps {
  title: string;
  previousTitle?: string | null;
  content: any;
  previousContent?: any;
  prevHistoryId?: string;
  persistedDiff?: IPageHistoryDiff;
  isDiffLoading: boolean;
  isPreviousLoading: boolean;
  isPreviousError: boolean;
}

function extractSchemaSpec(schema: Schema) {
  const nodes: Record<string, any> = {};
  schema.spec.nodes.forEach((name: string, spec: any) => {
    nodes[name] = {
      content: spec.content,
      group: spec.group,
      inline: spec.inline,
      atom: spec.atom,
      attrs: spec.attrs,
      marks: spec.marks,
      defining: spec.defining,
      isolating: spec.isolating,
      selectable: spec.selectable,
      draggable: spec.draggable,
      code: spec.code,
      whitespace: spec.whitespace,
    };
  });
  const marks: Record<string, any> = {};
  schema.spec.marks?.forEach((name: string, spec: any) => {
    marks[name] = {
      attrs: spec.attrs,
      inclusive: spec.inclusive,
      excludes: spec.excludes,
      group: spec.group,
      spanning: spec.spanning,
    };
  });
  return { nodes, marks, topNode: schema.spec.topNode };
}

function buildDecorations(
  schema: Schema,
  content: any,
  changes: DiffChange[],
  indexOffset = 0,
): DecorationSet {
  const newContent = Node.fromJSON(schema, content);
  const decorations: Decoration[] = [];
  let changeIndex = indexOffset;

  for (const change of changes) {
    if (change.fromB < change.toB) {
      changeIndex++;
      const idx = String(changeIndex);

      if (change.addedSpecialNode) {
        decorations.push(
          Decoration.node(
            change.addedSpecialNode.pos,
            change.addedSpecialNode.nodeEnd,
            { class: "history-diff-node-added", "data-diff-index": idx },
          ),
        );
      } else {
        decorations.push(
          Decoration.inline(change.fromB, change.toB, {
            class: "history-diff-added",
            "data-diff-index": idx,
          }),
        );
      }
    }

    if (change.fromA < change.toA) {
      changeIndex++;
      const idx = String(changeIndex);

      if (change.deletedSpecialNode) {
        const nodeJSON = change.deletedSpecialNode.nodeJSON;
        decorations.push(
          Decoration.widget(change.fromB, () => {
            const wrapper = document.createElement("div");
            wrapper.className = "history-diff-node-deleted";
            wrapper.setAttribute("data-diff-index", idx);
            const serializer = DOMSerializer.fromSchema(schema);
            const node = schema.nodeFromJSON(nodeJSON);
            const dom = serializer.serializeNode(node);
            wrapper.appendChild(dom);
            return wrapper;
          }),
        );
      } else if (change.deletedText) {
        const text = change.deletedText;
        decorations.push(
          Decoration.widget(change.fromB, () => {
            const span = document.createElement("span");
            span.className = "history-diff-deleted";
            span.setAttribute("data-diff-index", idx);
            span.textContent = text;
            return span;
          }),
        );
      }
    }
  }

  return DecorationSet.create(newContent, decorations);
}

export function HistoryEditor({
  title,
  previousTitle,
  content,
  previousContent,
  prevHistoryId,
  persistedDiff,
  isDiffLoading,
  isPreviousLoading,
  isPreviousError,
}: HistoryEditorProps) {
  const highlightChanges = useAtomValue(highlightChangesAtom);
  const [, setDiffCounts] = useAtom(diffCountsAtom);
  const setDiffState = useSetAtom(diffStateAtom);

  const updateDiffCounts = (v: DiffCounts | null) => {
    setDiffCounts(v);
  };
  const decorationSetRef = useRef<DecorationSet>(DecorationSet.empty);
  const [decorationVersion, setDecorationVersion] = useState(0);
  const setDecorations = (decorations: DecorationSet) => {
    decorationSetRef.current = decorations;
    setDecorationVersion((v) => v + 1);
  };

  const editor = useEditor({
    extensions: mainExtensions,
    editable: false,
  });

  const titleDiff = useMemo(
    () =>
      prevHistoryId && previousTitle !== undefined
        ? computeTitleDiff(previousTitle, title)
        : null,
    [prevHistoryId, previousTitle, title],
  );
  const titleAdded = titleDiff?.addedCount ?? 0;
  const titleDeleted = titleDiff?.deletedCount ?? 0;

  // Effect 1: immediate content render
  useEffect(() => {
    if (!editor || !content) return;
    decorationSetRef.current = DecorationSet.empty;
    editor.commands.setContent(content);
  }, [editor, content]);

  // Effect 2: use persisted diff first and fall back to the Web Worker
  useEffect(() => {
    if (!editor || !content || !prevHistoryId) {
      setDiffState("idle");
      updateDiffCounts(null);
      setDecorations(DecorationSet.empty);
      return;
    }

    const applyResult = (
      changes: DiffChange[],
      addedCount: number,
      deletedCount: number,
    ) => {
      try {
        const added = addedCount + titleAdded;
        const deleted = deletedCount + titleDeleted;
        setDecorations(
          buildDecorations(
            editor.schema,
            content,
            changes,
            titleAdded + titleDeleted,
          ),
        );
        updateDiffCounts({ added, deleted, total: added + deleted });
        setDiffState("ready");
      } catch (error) {
        console.error("History diff decorations failed:", error);
        setDecorations(DecorationSet.empty);
        updateDiffCounts(null);
        setDiffState("error");
      }
    };

    if (
      persistedDiff?.status === "ready" &&
      persistedDiff.fromHistoryId === prevHistoryId
    ) {
      applyResult(
        persistedDiff.changes,
        persistedDiff.addedCount,
        persistedDiff.deletedCount,
      );
      return;
    }

    if (persistedDiff?.status === "too_large") {
      setDecorations(DecorationSet.empty);
      updateDiffCounts(
        titleAdded + titleDeleted > 0
          ? {
              added: titleAdded,
              deleted: titleDeleted,
              total: titleAdded + titleDeleted,
            }
          : null,
      );
      setDiffState("tooLarge");
      return;
    }

    if (
      isDiffLoading ||
      persistedDiff?.status === "pending" ||
      persistedDiff?.status === "running"
    ) {
      setDecorations(DecorationSet.empty);
      updateDiffCounts(null);
      setDiffState("computing");
      return;
    }

    if (isPreviousLoading || !previousContent) {
      setDecorations(DecorationSet.empty);
      updateDiffCounts(null);
      setDiffState(isPreviousError ? "error" : "loadingPrevious");
      return;
    }

    setDiffState("computing");

    let worker: Worker;
    try {
      worker = new Worker(
        new URL("../workers/diff.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch (error) {
      console.error("History diff worker creation failed:", error);
      setDecorations(DecorationSet.empty);
      updateDiffCounts(null);
      setDiffState("error");
      return;
    }

    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === "result") {
        const { changes, addedCount, deletedCount } = e.data;
        applyResult(changes, addedCount, deletedCount);
      } else {
        console.error("History diff worker failed:", e.data.message);
        setDecorations(DecorationSet.empty);
        updateDiffCounts(null);
        setDiffState("error");
      }
      worker.terminate();
    };

    worker.onerror = (err) => {
      console.error("History diff worker error:", err);
      setDecorations(DecorationSet.empty);
      updateDiffCounts(null);
      setDiffState("error");
      worker.terminate();
    };

    worker.onmessageerror = (err) => {
      console.error("History diff worker message error:", err);
      setDecorations(DecorationSet.empty);
      updateDiffCounts(null);
      setDiffState("error");
      worker.terminate();
    };

    try {
      const schemaSpec = extractSchemaSpec(editor.schema);
      worker.postMessage({ schemaSpec, previousContent, content });
    } catch (error) {
      console.error("History diff worker start failed:", error);
      setDecorations(DecorationSet.empty);
      updateDiffCounts(null);
      setDiffState("error");
      worker.terminate();
    }

    return () => {
      worker.terminate();
    };
  }, [
    editor,
    content,
    previousContent,
    prevHistoryId,
    persistedDiff,
    isDiffLoading,
    isPreviousLoading,
    isPreviousError,
    titleAdded,
    titleDeleted,
    setDiffCounts,
    setDiffState,
  ]);

  // Effect 3: apply/toggle decorations
  useEffect(() => {
    if (!editor) return;
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        decorations: () =>
          highlightChanges ? decorationSetRef.current : DecorationSet.empty,
      },
    });
  }, [editor, highlightChanges, decorationVersion]);

  return (
    <div className={historyClasses.historyEditor}>
      <Title order={1}>
        {titleDiff && highlightChanges
          ? titleDiff.segments.map((segment, i) =>
              segment.type === "unchanged" ? (
                <span key={i}>{segment.value}</span>
              ) : (
                <span
                  key={i}
                  className={
                    segment.type === "added"
                      ? "history-diff-added"
                      : "history-diff-deleted"
                  }
                  data-diff-index={segment.diffIndex}
                >
                  {segment.value}
                </span>
              ),
            )
          : title}
      </Title>
      {editor && <EditorContent editor={editor} />}
    </div>
  );
}
