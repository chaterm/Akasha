import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import {
  MATCHABLE_CHAR_RE,
  normalizeCitationText,
  pickCitationQuote,
  toCitationQuote,
  type CitationQuote,
} from "@/features/editor/utils/citation-link";

const ANCHOR_LENGTH = 12;
const ANCHOR_ATTEMPTS = 6;
const HEADING_LOOKBACK = 3;
const FOLLOW_SCROLL_MS = 8000;

type IndexedText = { text: string; starts: number[]; ends: number[] };
export type TextRange = { from: number; to: number };

function leafTextOf(node: PMNode): string {
  const toText = node.type.spec.toText as
    | ((props: { node: PMNode }) => string)
    | undefined;
  return toText ? toText({ node }) : "";
}

function indexDocText(doc: PMNode): IndexedText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      let offset = 0;
      for (const char of node.text) {
        if (MATCHABLE_CHAR_RE.test(char)) {
          text += char;
          for (let i = 0; i < char.length; i += 1) {
            starts.push(pos + offset + i);
            ends.push(pos + offset + i + 1);
          }
        }
        offset += char.length;
      }
      return;
    }
    if (!node.isLeaf) return;
    const leafText = normalizeCitationText(leafTextOf(node));
    text += leafText;
    for (let i = 0; i < leafText.length; i += 1) {
      starts.push(pos);
      ends.push(pos + node.nodeSize);
    }
  });
  return { text, starts, ends };
}

function locate(
  haystack: string,
  needle: string,
  fromIndex = 0,
): TextRange | null {
  if (!needle) return null;
  const exact = haystack.indexOf(needle, fromIndex);
  if (exact >= 0) return { from: exact, to: exact + needle.length };
  if (needle.length <= ANCHOR_LENGTH * 2) return null;

  const chars = Array.from(needle);
  const anchorAt = (index: number) =>
    chars.slice(index, index + ANCHOR_LENGTH).join("");
  const step = Math.max(
    1,
    Math.floor((chars.length - ANCHOR_LENGTH) / ANCHOR_ATTEMPTS),
  );

  let from = -1;
  for (let i = 0; i + ANCHOR_LENGTH <= chars.length; i += step) {
    const found = haystack.indexOf(anchorAt(i), fromIndex);
    if (found >= 0) {
      from = found;
      break;
    }
  }
  if (from < 0) return null;

  const maxTo = from + needle.length * 2;
  for (let i = chars.length - ANCHOR_LENGTH; i >= 0; i -= step) {
    const anchor = anchorAt(i);
    const found = haystack.indexOf(anchor, from);
    if (found >= 0 && found + anchor.length <= maxTo) {
      return { from, to: found + anchor.length };
    }
  }
  return { from, to: from + ANCHOR_LENGTH };
}

function findAttachmentRange(
  doc: PMNode,
  attachmentId: string,
): TextRange | null {
  let range: TextRange | null = null;
  doc.descendants((node, pos) => {
    if (range) return false;
    const { attachmentId: id, src } = node.attrs as {
      attachmentId?: unknown;
      src?: unknown;
    };
    if (
      id === attachmentId ||
      (typeof src === "string" && src.includes(attachmentId))
    ) {
      range = { from: pos, to: pos + node.nodeSize };
      return false;
    }
  });
  return range;
}

export function findCitationRange(
  doc: PMNode,
  quote: CitationQuote,
): TextRange | null {
  if ("attachmentId" in quote) {
    return findAttachmentRange(doc, quote.attachmentId);
  }
  const { text, starts, ends } = indexDocText(doc);
  const startNeedle = normalizeCitationText(quote.start);
  const start = locate(text, startNeedle);
  if (!start) return null;

  let range = start;
  if (quote.end) {
    const end = locate(text, normalizeCitationText(quote.end), start.to);
    if (end) {
      const closest = text.lastIndexOf(
        startNeedle,
        end.from - startNeedle.length,
      );
      range = { from: Math.max(start.from, closest), to: end.to };
    }
  }
  return { from: starts[range.from], to: ends[range.to - 1] };
}

export function pickDocCitationQuote(
  doc: PMNode,
  answer: string,
  question: string,
): CitationQuote | null {
  const paragraphs: string[] = [];
  doc.descendants((node) => {
    if (!node.isTextblock) return;
    const text = node.textBetween(0, node.content.size, " ", leafTextOf);
    if (text.trim()) paragraphs.push(text.trim());
    return false;
  });
  const quote = pickCitationQuote([paragraphs.join("\n\n")], answer, question);
  return quote ? toCitationQuote(quote) : null;
}

export function citationAnchorBlock(
  doc: PMNode,
  pos: number,
): { pos: number; isHeading: boolean } {
  const blocks: Array<{ node: PMNode; pos: number }> = [];
  doc.forEach((node, offset) => blocks.push({ node, pos: offset }));
  const target = doc.resolve(pos).index(0);

  for (let i = target; i >= 0 && i >= target - HEADING_LOOKBACK; i -= 1) {
    const { node } = blocks[i];
    if (node.type.name === "heading") {
      return { pos: blocks[i].pos, isHeading: true };
    }
    if (i !== target && !node.isTextblock) break;
  }
  return { pos: blocks[target].pos, isHeading: false };
}

export function scrollToCitation(
  view: EditorView,
  range: TextRange,
): () => void {
  const anchor = citationAnchorBlock(view.state.doc, range.from);
  const element = view.nodeDOM(anchor.pos);
  if (!(element instanceof HTMLElement)) return () => {};

  const scroll = () => {
    if (element.isConnected) {
      element.scrollIntoView({ block: anchor.isHeading ? "start" : "center" });
    }
  };
  scroll();
  if (typeof ResizeObserver === "undefined") return () => {};

  const observer = new ResizeObserver(scroll);
  observer.observe(view.dom);
  const userEvents = ["wheel", "touchstart", "keydown", "mousedown"] as const;
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
    userEvents.forEach((name) => window.removeEventListener(name, stop, true));
  };
  const timer = setTimeout(stop, FOLLOW_SCROLL_MS);
  userEvents.forEach((name) =>
    window.addEventListener(name, stop, { capture: true, passive: true }),
  );
  return stop;
}
