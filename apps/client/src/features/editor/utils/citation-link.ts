export const CITATION_PARAM = "cite";

export type CitationQuote =
  | { start: string; end?: string }
  | { attachmentId: string };

const QUOTE_ANCHOR_SEPARATOR = "~";
const ATTACHMENT_PREFIX = "attachment:";
const MAX_INLINE_QUOTE_LENGTH = 48;
const QUOTE_ANCHOR_LENGTH = 20;
const GRAM_SIZE = 3;
const COPY_RATIO = 0.5;
const MIN_COPIED_GRAMS = 3;
const QUESTION_MATCH_RATIO = 0.5;
const MIN_QUESTION_GRAMS = 2;
const ATTACHMENT_ID_RE = /附件\s*ID:\s*([0-9a-fA-F-]{36})/;
const IMAGE_BLOCK_HEADING_RE = /^###\s*页面图片/;

export const MATCHABLE_CHAR_RE = /[\p{L}\p{N}]/u;

export function normalizeCitationText(value: string): string {
  let result = "";
  for (const char of value) {
    if (MATCHABLE_CHAR_RE.test(char)) result += char;
  }
  return result;
}

function gramsOf(value: string): string[] {
  const units = value.toLowerCase().match(/[a-z0-9]+|[\p{L}\p{N}]/gu) ?? [];
  if (units.length > 0 && units.length < GRAM_SIZE) return [units.join(" ")];
  const grams: string[] = [];
  for (let i = 0; i + GRAM_SIZE <= units.length; i += 1) {
    grams.push(units.slice(i, i + GRAM_SIZE).join(" "));
  }
  return grams;
}

type ExcerptBlock = { text: string; attachmentId?: string };

function splitExcerptBlocks(excerpts: string[]): ExcerptBlock[] {
  return excerpts.flatMap((excerpt) => {
    let attachmentId: string | undefined;
    return excerpt.split(/\n\s*\n/).flatMap((raw) => {
      const text = raw.trim();
      if (IMAGE_BLOCK_HEADING_RE.test(text)) {
        attachmentId = undefined;
        return [];
      }
      const id = text.match(ATTACHMENT_ID_RE)?.[1];
      if (id) attachmentId = id;
      if (normalizeCitationText(text).length === 0) return [];
      return [{ text, attachmentId }];
    });
  });
}

function quoteOf(block: ExcerptBlock): string {
  return block.attachmentId ? `附件 ID: ${block.attachmentId}` : block.text;
}

export function pickCitationQuote(
  excerpts: string[],
  answer: string,
  question = "",
): string | null {
  const blocks = splitExcerptBlocks(excerpts);
  if (blocks.length === 0) return null;

  const occurrences = new Map<string, number>();
  for (const block of blocks) {
    occurrences.set(block.text, (occurrences.get(block.text) ?? 0) + 1);
  }
  const candidates = blocks.filter(
    (block) => occurrences.get(block.text) === 1,
  );

  const questionGrams = new Set(gramsOf(question));
  if (questionGrams.size >= MIN_QUESTION_GRAMS) {
    let best: { block: ExcerptBlock; ratio: number } | null = null;
    for (const block of candidates) {
      const blockGrams = new Set(gramsOf(block.text));
      let matched = 0;
      for (const gram of questionGrams) if (blockGrams.has(gram)) matched += 1;
      const ratio = matched / questionGrams.size;
      if (
        matched >= MIN_QUESTION_GRAMS &&
        ratio >= QUESTION_MATCH_RATIO &&
        (!best || ratio > best.ratio)
      ) {
        best = { block, ratio };
      }
    }
    if (best) return quoteOf(best.block);
  }

  const firstIndexInAnswer = new Map<string, number>();
  gramsOf(answer).forEach((gram, index) => {
    if (!firstIndexInAnswer.has(gram)) firstIndexInAnswer.set(gram, index);
  });
  let best: { block: ExcerptBlock; mentionedAt: number } | null = null;
  for (const block of candidates) {
    const grams = new Set(gramsOf(block.text));
    let copied = 0;
    let mentionedAt = Infinity;
    for (const gram of grams) {
      const index = firstIndexInAnswer.get(gram);
      if (index === undefined) continue;
      copied += 1;
      mentionedAt = Math.min(mentionedAt, index);
    }
    if (copied < MIN_COPIED_GRAMS || copied / grams.size <= COPY_RATIO) {
      continue;
    }
    if (!best || mentionedAt < best.mentionedAt) best = { block, mentionedAt };
  }

  return quoteOf(best?.block ?? blocks[0]);
}

export function toCitationQuote(quote: string): CitationQuote | null {
  const attachmentId = quote.match(ATTACHMENT_ID_RE)?.[1];
  if (attachmentId) return { attachmentId };
  const chars = Array.from(normalizeCitationText(quote));
  if (chars.length === 0) return null;
  if (chars.length <= MAX_INLINE_QUOTE_LENGTH) return { start: chars.join("") };
  return {
    start: chars.slice(0, QUOTE_ANCHOR_LENGTH).join(""),
    end: chars.slice(-QUOTE_ANCHOR_LENGTH).join(""),
  };
}

export function buildCitationHref(href: string, quote: string): string {
  const citation = toCitationQuote(quote);
  if (!citation) return href;

  const url = new URL(href, "https://akasha.invalid");
  url.searchParams.set(
    CITATION_PARAM,
    "attachmentId" in citation
      ? `${ATTACHMENT_PREFIX}${citation.attachmentId}`
      : citation.end
        ? `${citation.start}${QUOTE_ANCHOR_SEPARATOR}${citation.end}`
        : citation.start,
  );
  return `${url.pathname}${url.search}${url.hash}`;
}

export function readCitationQuote(
  value: string | null | undefined,
): CitationQuote | null {
  const raw = (value ?? "").trim();
  if (raw.startsWith(ATTACHMENT_PREFIX)) {
    const attachmentId = raw.slice(ATTACHMENT_PREFIX.length).trim();
    return attachmentId ? { attachmentId } : null;
  }
  const [start, end] = raw
    .split(QUOTE_ANCHOR_SEPARATOR)
    .map((part) => part.trim());
  if (!start) return null;
  return end ? { start, end } : { start };
}
