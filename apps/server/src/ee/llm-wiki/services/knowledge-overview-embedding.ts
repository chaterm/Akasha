export const MAX_KNOWLEDGE_OVERVIEW_EMBEDDING_CHARACTERS = 4_000;

const KNOWLEDGE_CATALOG_HEADING = /\n+## Knowledge catalog\s*\n/i;

export function buildKnowledgeOverviewEmbeddingText(input: {
  title?: string;
  narrative: string;
}): string {
  const value = [input.title?.trim(), input.narrative.trim()]
    .filter(Boolean)
    .join('\n\n');
  if (value.length <= MAX_KNOWLEDGE_OVERVIEW_EMBEDDING_CHARACTERS) {
    return value;
  }

  const bounded = value.slice(0, MAX_KNOWLEDGE_OVERVIEW_EMBEDDING_CHARACTERS);
  const preferredBreak = Math.max(
    bounded.lastIndexOf('\n'),
    bounded.lastIndexOf('。') + 1,
    bounded.lastIndexOf('. ') + 1,
    bounded.lastIndexOf('；') + 1,
  );
  return preferredBreak >= MAX_KNOWLEDGE_OVERVIEW_EMBEDDING_CHARACTERS * 0.75
    ? bounded.slice(0, preferredBreak).trimEnd()
    : bounded.trimEnd();
}

export function extractKnowledgeOverviewNarrative(
  contentMarkdown: string,
): string {
  const marker = KNOWLEDGE_CATALOG_HEADING.exec(contentMarkdown);
  return (
    marker ? contentMarkdown.slice(0, marker.index) : contentMarkdown
  ).trim();
}
