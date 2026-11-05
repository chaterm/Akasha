import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { useEffect } from "react";

/** Distance from the scroll edge where accelerated scrolling starts. */
const EDGE_BAND_PX = 96;
/** Scroll rate at the far end of the band and at the edge itself. */
const MIN_SPEED_PX_PER_SECOND = 240;
const MAX_SPEED_PX_PER_SECOND = 8000;
/** Long frames (background tab, GC pause) must not jump the document. */
const MAX_FRAME_MS = 64;

/**
 * Scroll rate for a drag selection, in CSS px per second. Positive scrolls
 * down, negative scrolls up, zero keeps the current scroll position.
 *
 * The rate grows quadratically as the pointer approaches the edge of the
 * scrollable area, which is what makes long selections feel like they
 * accelerate instead of crawling at the browser's fixed auto-scroll rate.
 */
export function selectionScrollSpeed(
  clientY: number,
  top: number,
  bottom: number,
  edgeBand = EDGE_BAND_PX,
): number {
  if (clientY <= top) return -Infinity;
  if (clientY >= bottom) return Infinity;
  const distance = Math.min(clientY - top, bottom - clientY);
  if (distance >= edgeBand) return 0;
  const ratio = 1 - distance / edgeBand;
  const speed =
    MIN_SPEED_PX_PER_SECOND +
    (MAX_SPEED_PX_PER_SECOND - MIN_SPEED_PX_PER_SECOND) * ratio * ratio;
  return clientY < (top + bottom) / 2 ? -speed : speed;
}

interface SelectionDrag {
  clientX: number;
  clientY: number;
  scroller: HTMLElement;
}

function isDocumentScroller(scroller: HTMLElement) {
  return scroller === document.scrollingElement || scroller === document.body;
}

function findScroller(target: HTMLElement): HTMLElement {
  let node: HTMLElement | null = target;
  while (node && node !== document.body) {
    const { overflowY } = window.getComputedStyle(node);
    if (
      /(auto|scroll|overlay)/.test(overflowY) &&
      node.scrollHeight - node.clientHeight > 1
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return (
    (document.scrollingElement as HTMLElement | null) ??
    document.documentElement
  );
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

    const bounds = (scroller: HTMLElement) =>
      isDocumentScroller(scroller)
        ? { top: 0, bottom: window.innerHeight }
        : {
            top: scroller.getBoundingClientRect().top,
            bottom: scroller.getBoundingClientRect().bottom,
          };

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
      const speed = selectionScrollSpeed(drag.clientY, top, bottom);
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
