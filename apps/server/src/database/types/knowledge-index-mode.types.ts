export type KnowledgeIndexMode = 'compiled' | 'original';

export const DEFAULT_KNOWLEDGE_INDEX_MODE: KnowledgeIndexMode = 'compiled';

/**
 * Space-level publish mode. `default` lets each page choose (falling back to
 * `compiled`); `compiled` / `original` lock every page in the Space.
 */
export type KnowledgeSpaceIndexMode = KnowledgeIndexMode | 'default';

export const KNOWLEDGE_SPACE_INDEX_MODE_DEFAULT = 'default' as const;

/** Page-level publish mode choice. `inherit` clears the page setting. */
export type KnowledgePageIndexModeChoice = KnowledgeIndexMode | 'inherit';

export const KNOWLEDGE_PAGE_INDEX_MODE_INHERIT = 'inherit' as const;

export function isKnowledgeIndexMode(
  value: unknown,
): value is KnowledgeIndexMode {
  return value === 'compiled' || value === 'original';
}

/** Reads the Space-level mode from a `spaces.settings` JSON value. */
export function readSpaceKnowledgeIndexMode(
  settings: unknown,
): KnowledgeSpaceIndexMode {
  const mode = (settings as { knowledge?: { indexMode?: unknown } } | null)
    ?.knowledge?.indexMode;
  return isKnowledgeIndexMode(mode) ? mode : KNOWLEDGE_SPACE_INDEX_MODE_DEFAULT;
}

/** A locked Space mode wins; otherwise the page setting, then `compiled`. */
export function resolveEffectiveKnowledgeIndexMode(input: {
  pageIndexMode: KnowledgeIndexMode | null;
  spaceIndexMode: KnowledgeSpaceIndexMode;
}): KnowledgeIndexMode {
  if (isKnowledgeIndexMode(input.spaceIndexMode)) return input.spaceIndexMode;
  return input.pageIndexMode ?? DEFAULT_KNOWLEDGE_INDEX_MODE;
}
