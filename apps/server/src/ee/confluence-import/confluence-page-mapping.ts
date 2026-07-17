import { Json, JsonObject } from '@akasha/db/types/db';

export type ConfluencePageMapping = {
  confluencePageId: string;
  akashaPageId: string;
  title: string;
};

export function parseConfluencePageId(filePath: string): string | null {
  const value = String(filePath || '').trim();
  if (!value || value.includes('\\')) return null;
  const segments = value.split('/');
  if (
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..',
    )
  ) {
    return null;
  }
  const match = segments[segments.length - 1]?.match(
    /(?:^|_)([1-9]\d*)\.html$/,
  );
  return match?.[1] ?? null;
}

export function mergeConfluencePageMappings(
  metadata: Json | null,
  mappings: ConfluencePageMapping[],
): JsonObject {
  if (metadata !== null && !isJsonObject(metadata)) {
    throw new Error('Import task metadata must be a JSON object');
  }
  if (!Array.isArray(mappings)) {
    throw new Error('Confluence page mappings must be an array');
  }

  const sourceIds = new Set<string>();
  const targetIds = new Set<string>();
  const pageMappings = mappings.map((mapping) => {
    const confluencePageId = String(mapping?.confluencePageId || '').trim();
    const akashaPageId = String(mapping?.akashaPageId || '').trim();
    if (!/^[1-9]\d*$/.test(confluencePageId)) {
      throw new Error(`Invalid Confluence page ID: ${confluencePageId || '(empty)'}`);
    }
    if (!akashaPageId) {
      throw new Error(`Missing Akasha page ID for Confluence page ${confluencePageId}`);
    }
    if (sourceIds.has(confluencePageId)) {
      throw new Error(`Duplicate Confluence page ID: ${confluencePageId}`);
    }
    if (targetIds.has(akashaPageId)) {
      throw new Error(`Duplicate Akasha page ID: ${akashaPageId}`);
    }
    sourceIds.add(confluencePageId);
    targetIds.add(akashaPageId);
    return {
      confluencePageId,
      akashaPageId,
      title: String(mapping?.title || '').trim(),
    };
  });

  const baseMetadata: JsonObject = metadata === null
    ? {}
    : (metadata as JsonObject);
  return {
    ...baseMetadata,
    pageMappings,
  };
}

function isJsonObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
