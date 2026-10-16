export type KnowledgeIndexMode = 'compiled' | 'original';

export const DEFAULT_KNOWLEDGE_INDEX_MODE: KnowledgeIndexMode = 'compiled';

export function isKnowledgeIndexMode(
  value: unknown,
): value is KnowledgeIndexMode {
  return value === 'compiled' || value === 'original';
}
