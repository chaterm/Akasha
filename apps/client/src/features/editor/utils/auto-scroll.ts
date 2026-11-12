export const EDGE_BAND_PX = 96;
export const MIN_SPEED_PX_PER_SECOND = 240;
export const MAX_SPEED_PX_PER_SECOND = 2400;
export const MAX_FRAME_MS = 64;

export function autoScrollSpeed(
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

export function isDocumentScroller(scroller: HTMLElement) {
  return scroller === document.scrollingElement || scroller === document.body;
}

export function findScroller(target: HTMLElement): HTMLElement {
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

export function scrollerBounds(scroller: HTMLElement) {
  if (isDocumentScroller(scroller)) {
    return { top: 0, bottom: window.innerHeight };
  }
  const rect = scroller.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom };
}
