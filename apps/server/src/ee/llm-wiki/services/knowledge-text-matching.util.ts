/**
 * Shared lexical matching helpers used by both retrieval ranking and image
 * citation resolution. Kept in one place so image weak-association scoring uses
 * the exact same tokenization/normalization as retrieval, avoiding drift and
 * flaky tests.
 */

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

/**
 * Extract informative terms from a piece of text:
 * - ASCII runs `[a-z0-9_./:-]{2,}` (preserves UUIDs, identifiers, API paths),
 *   minus common English stop words.
 * - Chinese 2-grams over Han runs, minus common Chinese stop words.
 */
export function informativeTerms(value: string): string[] {
  const normalized = normalizeSearchText(value);
  const asciiStopWords = new Set([
    'and',
    'are',
    'for',
    'how',
    'the',
    'what',
    'when',
    'where',
    'which',
    'who',
    'why',
  ]);
  const ascii = (normalized.match(/[a-z0-9_./:-]{2,}/g) ?? []).filter(
    (term) => !asciiStopWords.has(term),
  );
  const hanStopWords = new Set([
    '什么',
    '如何',
    '多少',
    '时候',
    '的是',
    '一下',
  ]);
  const han = (normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []).flatMap(
    (segment) =>
      Array.from({ length: Math.max(0, segment.length - 1) }, (_, index) =>
        segment.slice(index, index + 2),
      ).filter((term) => !hanStopWords.has(term)),
  );
  return [...new Set([...ascii, ...han])];
}

export function hasInformativeTextOverlap(query: string, text: string): boolean {
  const queryTerms = informativeTerms(query);
  if (queryTerms.length === 0) return false;
  const normalizedText = normalizeSearchText(text);
  return queryTerms.some((term) => normalizedText.includes(term));
}
