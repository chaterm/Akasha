import { useEffect, type RefObject } from "react";
import { computePinTop } from "@docmost/editor-ext";

/**
 * Keeps the header row of a table visible below the page's fixed bars while
 * the table scrolls with the page. The table's own box scrolls sideways, so
 * native `position: sticky` (which would stick to that box) cannot be used;
 * the row is shifted with a transform instead, like the editor's tables.
 */
export function useStickyHeader(
  table: RefObject<HTMLTableElement | null>,
  enabled = true,
) {
  useEffect(() => {
    const element = table.current;
    if (!element || !enabled) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const header = element.tHead?.rows[0];
      if (!header) return;
      const top = computePinTop();
      const rect = element.getBoundingClientRect();
      const height = header.getBoundingClientRect().height;
      const offset =
        rect.top < top ? Math.min(top - rect.top, rect.height - height) : 0;
      header.style.transform = offset > 0 ? `translateY(${offset}px)` : "";
      header.toggleAttribute("data-pinned", offset > 0);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    document.addEventListener("scroll", schedule, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      const header = element.tHead?.rows[0];
      if (header) {
        header.style.transform = "";
        header.removeAttribute("data-pinned");
      }
    };
  }, [table, enabled]);
}
