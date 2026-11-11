import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { useEffect } from "react";
import {
  autoScrollSpeed,
  findScroller,
  MAX_FRAME_MS,
  scrollerBounds,
} from "@/features/editor/utils/auto-scroll";

export { autoScrollSpeed as selectionScrollSpeed };

interface SelectionDrag {
  clientX: number;
  clientY: number;
  scroller: HTMLElement;
}

/**
 * Accelerates selection drag-scrolling inside the page editor.
 *
 * Native selection auto-scroll is fixed-rate and only starts once the pointer
 * leaves the viewport, so selecting several screens of text crawls. This hook
 * drives the scroll itself near and past the edges of the scrollable area and
 * keeps the ProseMirror selection in sync with the content moving under it.
 */
export function useSelectionAutoScroll(editor: Editor | null) {
  useEffect(() => {
    if (!editor) return;

    const view = editor.view;
    const root = view.dom as HTMLElement;

    let drag: SelectionDrag | null = null;
    let frame = 0;
    let lastFrameAt = 0;

    const bounds = scrollerBounds;

    const extendSelection = (clientX: number, clientY: number) => {
      if (view.dragging) return;
      const { state } = view;
      if (state.selection.empty) return;
      const { top, bottom } = bounds(
        (document.scrollingElement as HTMLElement) ?? document.documentElement,
      );
      const pointerTop = Math.min(
        Math.max(clientY, top + 1),
        Math.max(bottom - 1, top + 1),
      );
      const hit = view.posAtCoords({ left: clientX, top: pointerTop });
      if (!hit || hit.pos === state.selection.head) return;
      view.dispatch(
        state.tr.setSelection(
          TextSelection.create(state.doc, state.selection.anchor, hit.pos),
        ),
      );
    };

    const extendSelectionToBoundary = (toEnd: boolean) => {
      if (view.dragging) return;
      const { state } = view;
      if (state.selection.empty) return;
      const { anchor } = state.selection;
      const selection = TextSelection.between(
        state.doc.resolve(anchor),
        state.doc.resolve(toEnd ? state.doc.content.size : 0),
      );
      if (selection.head === state.selection.head) return;
      view.dispatch(state.tr.setSelection(selection));
    };

    const tick = (now: number) => {
      frame = 0;
      if (!drag) return;
      const elapsed = lastFrameAt
        ? Math.min(now - lastFrameAt, MAX_FRAME_MS)
        : 16;
      lastFrameAt = now;
      const { top, bottom } = bounds(drag.scroller);
      const speed = autoScrollSpeed(drag.clientY, top, bottom);
      if (!Number.isFinite(speed)) {
        const toEnd = speed > 0;
        drag.scroller.scrollTop = toEnd ? drag.scroller.scrollHeight : 0;
        extendSelectionToBoundary(toEnd);
      } else if (speed !== 0) {
        const previous = drag.scroller.scrollTop;
        drag.scroller.scrollTop = previous + (speed * elapsed) / 1000;
        if (drag.scroller.scrollTop !== previous) {
          extendSelection(drag.clientX, drag.clientY);
        }
      }
      frame = requestAnimationFrame(tick);
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || !view.editable) return;
      const target = event.target as HTMLElement | null;
      if (!target || !root.contains(target)) return;
      // Nested editors (database cells, embedded editors) run their own drag.
      if (target.closest('[contenteditable="true"]') !== root) return;
      if (target.closest("[data-drag-handle]")) return;
      drag = {
        clientX: event.clientX,
        clientY: event.clientY,
        scroller: findScroller(target),
      };
      lastFrameAt = 0;
      if (!frame) frame = requestAnimationFrame(tick);
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!drag) return;
      drag.clientX = event.clientX;
      drag.clientY = event.clientY;
    };

    const stop = () => {
      drag = null;
      lastFrameAt = 0;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };

    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseup", stop, true);
    window.addEventListener("blur", stop);

    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("mouseup", stop, true);
      window.removeEventListener("blur", stop);
      stop();
    };
  }, [editor]);
}
