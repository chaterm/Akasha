export type KnowledgeIndexMode = 'compiled' | 'original';

export const DEFAULT_KNOWLEDGE_INDEX_MODE: KnowledgeIndexMode = 'compiled';

export type KnowledgeSpaceIndexMode = KnowledgeIndexMode | 'default';

export const KNOWLEDGE_SPACE_INDEX_MODE_DEFAULT = 'default' as const;

export type KnowledgePageIndexModeChoice = KnowledgeIndexMode | 'inherit';

export const KNOWLEDGE_PAGE_INDEX_MODE_INHERIT = 'inherit' as const;

export function isKnowledgeIndexMode(
  value: unknown,
): value is KnowledgeIndexMode {
  return value === 'compiled' || value === 'original';
}

export function readSpaceKnowledgeIndexMode(
  settings: unknown,
): KnowledgeSpaceIndexMode {
  const mode = (settings as { knowledge?: { indexMode?: unknown } } | null)
    ?.knowledge?.indexMode;
  return isKnowledgeIndexMode(mode) ? mode : KNOWLEDGE_SPACE_INDEX_MODE_DEFAULT;
}

export function resolveEffectiveKnowledgeIndexMode(input: {
  pageIndexMode: KnowledgeIndexMode | null;
  spaceIndexMode: KnowledgeSpaceIndexMode;
}): KnowledgeIndexMode {
  if (isKnowledgeIndexMode(input.spaceIndexMode)) return input.spaceIndexMode;
  return input.pageIndexMode ?? DEFAULT_KNOWLEDGE_INDEX_MODE;
}
