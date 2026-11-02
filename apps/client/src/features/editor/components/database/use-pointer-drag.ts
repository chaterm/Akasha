import { useCallback, useRef, useState, type PointerEvent } from "react";

/**
 * Pointer-event drag with a floating preview. Native HTML5 drag and drop is
 * avoided on purpose: ProseMirror listens to it (dropcursor, drop handling)
 * and its drag image cannot be styled.
 *
 * `onMove` / `onDrop` get the pointer position; callers hit-test with
 * `document.elementsFromPoint` (the preview has `pointer-events: none`).
 * A press that moves less than `threshold` px stays a normal click.
 */
export interface PointerDragOptions<T> {
  onStart?: (data: T) => void;
  onMove: (data: T, x: number, y: number) => void;
  onDrop: (data: T, x: number, y: number) => void;
  onCancel?: (data: T) => void;
  /** Container scrolled when the pointer nears its edges. */
  scrollContainer?: () => HTMLElement | null;
  threshold?: number;
  /** Preview rotation in degrees. */
  tilt?: number;
  /** Page cursor while dragging. */
  cursor?: string;
}

const EDGE = 40;
const STEP = 12;

function autoScroll(container: HTMLElement | null, x: number, y: number) {
  if (!container) return;
  const rect = container.getBoundingClientRect();
  if (x < rect.left + EDGE) container.scrollLeft -= STEP;
  else if (x > rect.right - EDGE) container.scrollLeft += STEP;
  if (y < rect.top + EDGE) container.scrollTop -= STEP;
  else if (y > rect.bottom - EDGE) container.scrollTop += STEP;
}

function createPreview(source: HTMLElement, tilt: number): HTMLElement {
  const rect = source.getBoundingClientRect();
  let preview = source.cloneNode(true) as HTMLElement;
  if (source.tagName === "TR") {
    // A bare <tr> loses its cell layout outside a table.
    const table = document.createElement("table");
    table.className = source.closest("table")?.className ?? "";
    table.style.tableLayout = "fixed";
    table.style.borderCollapse = "collapse";
    const cells = source.querySelectorAll<HTMLElement>(":scope > td");
    preview
      .querySelectorAll<HTMLElement>(":scope > td")
      .forEach((cell, index) => {
        cell.style.width = `${cells[index]?.getBoundingClientRect().width ?? 0}px`;
      });
    const body = document.createElement("tbody");
    body.appendChild(preview);
    table.appendChild(body);
    preview = table;
  }
  Object.assign(preview.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    pointerEvents: "none",
    zIndex: "1000",
    opacity: "0.9",
    boxShadow: "var(--mantine-shadow-md)",
    background: "var(--mantine-color-body)",
  });
  preview.dataset.tilt = String(tilt);
  document.body.appendChild(preview);
  return preview;
}

/** Forces one cursor on the whole page; remove the returned element to undo. */
function lockCursor(cursor?: string): HTMLStyleElement | null {
  if (!cursor) return null;
  const style = document.createElement("style");
  style.textContent = `* { cursor: ${cursor} !important; }`;
  document.head.appendChild(style);
  return style;
}

export function usePointerDrag<T>(options: PointerDragOptions<T>) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [dragging, setDragging] = useState<T | null>(null);

  const onPointerDown = useCallback(
    (
      event: PointerEvent<HTMLElement>,
      data: T,
      source?: HTMLElement | null,
    ) => {
      if (event.button !== 0) return;
      const element = source ?? event.currentTarget;
      const startX = event.clientX;
      const startY = event.clientY;
      const rect = element.getBoundingClientRect();
      const offsetX = startX - rect.left;
      const offsetY = startY - rect.top;
      const threshold = optionsRef.current.threshold ?? 4;
      let preview: HTMLElement | null = null;
      let cursorStyle: HTMLStyleElement | null = null;

      const place = (x: number, y: number) => {
        if (!preview) return;
        const tilt = Number(preview.dataset.tilt) || 0;
        preview.style.transform = `translate(${x - offsetX}px, ${y - offsetY}px) rotate(${tilt}deg)`;
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("keydown", onKey, true);
        if (preview) document.body.style.userSelect = "";
        cursorStyle?.remove();
        cursorStyle = null;
        preview?.remove();
        preview = null;
        setDragging(null);
      };

      const onMove = (move: globalThis.PointerEvent) => {
        if (!preview) {
          if (
            Math.hypot(move.clientX - startX, move.clientY - startY) < threshold
          )
            return;
          preview = createPreview(element, optionsRef.current.tilt ?? 0);
          // No text selection while dragging across the page.
          document.body.style.userSelect = "none";
          cursorStyle = lockCursor(optionsRef.current.cursor);
          setDragging(data);
          optionsRef.current.onStart?.(data);
        }
        move.preventDefault();
        place(move.clientX, move.clientY);
        autoScroll(
          optionsRef.current.scrollContainer?.() ?? null,
          move.clientX,
          move.clientY,
        );
        optionsRef.current.onMove(data, move.clientX, move.clientY);
      };

      const onUp = (up: globalThis.PointerEvent) => {
        const wasDragging = !!preview;
        cleanup();
        if (!wasDragging) return;
        // The click that follows a drag must not open or select anything.
        window.addEventListener(
          "click",
          (click) => {
            click.stopPropagation();
            click.preventDefault();
          },
          { capture: true, once: true },
        );
        optionsRef.current.onDrop(data, up.clientX, up.clientY);
      };

      const onKey = (key: KeyboardEvent) => {
        if (key.key !== "Escape" || !preview) return;
        key.stopPropagation();
        cleanup();
        optionsRef.current.onCancel?.(data);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("keydown", onKey, true);
    },
    [],
  );

  return { onPointerDown, dragging };
}

/** Index of the list item under the pointer, split at each item's midpoint ("insert before" index). */
export function hitTestList(
  container: HTMLElement | null,
  selector: string,
  axis: "x" | "y",
  x: number,
  y: number,
): number {
  if (!container) return -1;
  const items = [...container.querySelectorAll<HTMLElement>(selector)];
  const index = items.findIndex((item) => {
    const rect = item.getBoundingClientRect();
    return axis === "y"
      ? y < rect.top + rect.height / 2
      : x < rect.left + rect.width / 2;
  });
  return index < 0 ? items.length : index;
}

/** The closest ancestor (under the pointer) matching `selector`. */
export function elementAt(
  x: number,
  y: number,
  selector: string,
): HTMLElement | null {
  for (const element of document.elementsFromPoint(x, y)) {
    const match = (element as HTMLElement).closest?.(
      selector,
    ) as HTMLElement | null;
    if (match) return match;
  }
  return null;
}
