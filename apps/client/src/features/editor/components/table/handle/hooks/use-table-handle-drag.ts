import { useEffect } from "react";
import type { Editor } from "@tiptap/react";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { disableNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview";
import {
  autoScrollForElements,
  autoScrollWindowForElements,
} from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { getTableHandlePluginSpec } from "@docmost/editor-ext";

export function useTableHandleDrag(
  editor: Editor,
  orientation: "col" | "row",
  element: HTMLElement | null,
  wrapper: HTMLElement | null,
  onDragStart?: () => void,
) {
  useEffect(() => {
    if (!element) return;

    return combine(
      draggable({
        element,
        getInitialData: () => ({ type: `table-${orientation}` }),
        onGenerateDragPreview: ({ nativeSetDragImage }) => {
          disableNativeDragPreview({ nativeSetDragImage });
        },
        onDragStart: ({ location }) => {
          onDragStart?.();
          const spec = getTableHandlePluginSpec(editor);
          if (!spec) return;
          const { clientX, clientY } = location.initial.input;
          spec.startDragFromHandle(orientation, clientX, clientY);
        },
        onDrag: ({ location }) => {
          const spec = getTableHandlePluginSpec(editor);
          if (!spec) return;
          const { clientX, clientY } = location.current.input;
          spec.updateDragPosition(clientX, clientY);
        },
        onDrop: ({ location }) => {
          const spec = getTableHandlePluginSpec(editor);
          if (!spec) return;
          const { clientX, clientY } = location.current.input;
          spec.updateDragPosition(clientX, clientY);
          spec.commitDrop();
          spec.endDrag();
        },
      }),
      orientation === "col" &&
        wrapper &&
        !wrapper.classList.contains("tableWrapperNoOverflow")
        ? autoScrollForElements({
            element: wrapper,
            getAllowedAxis: () => "horizontal",
          })
        : () => {},
      autoScrollWindowForElements({ getAllowedAxis: () => "vertical" }),
    );
  }, [editor, orientation, element, wrapper, onDragStart]);
}
