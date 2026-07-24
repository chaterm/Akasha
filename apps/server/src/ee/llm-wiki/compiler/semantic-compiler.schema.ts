import { z } from 'zod';

const canonicalKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => !value.includes('..'), 'canonical key cannot contain ..')
  .refine(
    (value) => /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u.test(value),
    'canonical key contains unsafe characters',
  );

const compilerVersionSchema = z.preprocess(
  (value) => (value === 1 ? '1' : value),
  z.literal('1'),
);

const evidenceQuotesSchema = z.preprocess(
  (value) => (value == null ? [] : typeof value === 'string' ? [value] : value),
  z.array(z.string().trim().min(1)).max(20),
);

function arrayOrEmpty<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value == null ? [] : value), schema);
}

const analyzedEntitySchema = z
  .object({
    canonicalKey: canonicalKeySchema,
    name: z.string().trim().min(1),
    type: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1),
    evidenceQuotes: evidenceQuotesSchema.default([]),
  })
  .strict();

const analyzedConceptSchema = z
  .object({
    canonicalKey: canonicalKeySchema,
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    evidenceQuotes: evidenceQuotesSchema.default([]),
  })
  .strict();

const analyzedClaimSchema = z
  .object({
    text: z.string().trim().min(1),
    confidence: z.number().min(0).max(1).optional(),
    evidenceQuote: z.string().trim().min(1),
  })
  .strict();

const analyzedRelationSchema = z
  .object({
    fromCanonicalKey: canonicalKeySchema,
    toCanonicalKey: canonicalKeySchema,
    relation: z.string().trim().min(1),
    evidenceQuote: z.string().trim().min(1).optional(),
  })
  .strict();

const analyzedComparisonSchema = z
  .object({
    canonicalKey: canonicalKeySchema,
    title: z.string().trim().min(1),
    subjects: z.array(canonicalKeySchema).min(2).max(12),
    summary: z.string().trim().min(1),
    evidenceQuotes: evidenceQuotesSchema.default([]),
  })
  .strict();

const analyzedContradictionSchema = z
  .object({
    description: z.string().trim().min(1),
    relatedCanonicalKeys: z.array(canonicalKeySchema).default([]),
    evidenceQuotes: evidenceQuotesSchema.default([]),
  })
  .strict();

export const semanticAnalysisSchema = z
  .object({
    version: compilerVersionSchema,
    synopsis: z.string().trim().min(1),
    language: z.string().trim().min(1),
    entities: arrayOrEmpty(z.array(analyzedEntitySchema).max(100)),
    concepts: arrayOrEmpty(z.array(analyzedConceptSchema).max(100)),
    claims: arrayOrEmpty(z.array(analyzedClaimSchema).max(200)),
    relations: arrayOrEmpty(z.array(analyzedRelationSchema).max(200)),
    comparisons: arrayOrEmpty(z.array(analyzedComparisonSchema).max(50)),
    contradictions: arrayOrEmpty(z.array(analyzedContradictionSchema).max(50)),
  })
  .strict();

export type SemanticAnalysis = z.infer<typeof semanticAnalysisSchema>;

const generatedClaimSchema = z
  .object({
    text: z.string().trim().min(1),
    confidence: z.number().min(0).max(1).optional(),
    evidenceQuote: z.string().trim().min(1),
  })
  .strict();

const generatedLinkSchema = z
  .object({
    targetKind: z.enum(['source_summary', 'concept', 'entity', 'comparison']),
    targetCanonicalKey: canonicalKeySchema,
    relation: z.string().trim().min(1),
    evidenceQuote: z.string().trim().min(1).optional(),
  })
  .strict();

export const semanticGeneratedArtifactSchema = z
  .object({
    kind: z.enum(['source_summary', 'concept', 'entity', 'comparison']),
    canonicalKey: canonicalKeySchema,
    title: z.string().trim().min(1).max(300),
    markdown: z.string().trim().min(1),
    claims: arrayOrEmpty(z.array(generatedClaimSchema).max(200)),
    links: arrayOrEmpty(z.array(generatedLinkSchema).max(200)),
    tags: arrayOrEmpty(z.array(z.string().trim().min(1)).max(50)),
  })
  .strict();

export type SemanticGeneratedArtifact = z.infer<
  typeof semanticGeneratedArtifactSchema
>;

export const semanticGenerationSchema = z
  .object({
    version: compilerVersionSchema,
    artifacts: z.array(semanticGeneratedArtifactSchema).min(1).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    const summaryCount = value.artifacts.filter(
      (artifact) => artifact.kind === 'source_summary',
    ).length;
    if (summaryCount !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['artifacts'],
        message: 'generation must contain exactly one source_summary',
      });
    }
  });

export type SemanticGeneration = z.infer<typeof semanticGenerationSchema>;

export type SemanticCompilerStage = 'analysis' | 'generation';

export class SemanticCompilerOutputError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SemanticCompilerOutputError';
  }
}

export function parseSemanticAnalysisJson(text: string): SemanticAnalysis {
  return parseStrictJson(text, semanticAnalysisSchema, 'analysis');
}

export function parseSemanticGenerationJson(text: string): SemanticGeneration {
  return parseStrictJson(text, semanticGenerationSchema, 'generation');
}

/**
 * Normalizes common JSON-mode variations without weakening the persisted
 * compiler schemas. Unknown fields are discarded, aliases are folded into the
 * canonical contract, and malformed optional collection entries are skipped.
 * The returned value must still pass the strict Zod schema before publication.
 */
export function repairSemanticCompilerOutput(
  stage: SemanticCompilerStage,
  value: unknown,
): unknown {
  const parsedValue =
    typeof value === 'string' ? parseRelaxedJsonObject(value) : value;
  const root = asRecord(parsedValue);
  if (!root) return parsedValue;

  return stage === 'analysis'
    ? repairAnalysisOutput(root)
    : repairGenerationOutput(root);
}

function parseStrictJson<T>(
  text: string,
  schema: z.ZodType<T>,
  stage: string,
): T {
  const json = extractStrictJsonObject(text);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new SemanticCompilerOutputError(
      `${stage} output is not valid JSON`,
      error,
    );
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw new SemanticCompilerOutputError(
      `${stage} output does not match the schema: ${detail}`,
      parsed.error,
    );
  }
  return parsed.data;
}

function extractStrictJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  if (fenced?.[1]?.trim().startsWith('{') && fenced[1].trim().endsWith('}')) {
    return fenced[1].trim();
  }

  throw new SemanticCompilerOutputError(
    'compiler output must be a strict JSON object with no explanatory prose',
  );
}

function parseRelaxedJsonObject(text: string): unknown {
  const candidate = extractRelaxedJsonObject(text);
  if (!candidate) return text;
  try {
    return JSON.parse(candidate);
  } catch {
    return text;
  }
}

function extractRelaxedJsonObject(text: string): string | undefined {
  const trimmed = text.trim().replace(/^\uFEFF/u, '');
  const fenced = /^```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```$/iu.exec(
    trimmed,
  );
  const source = fenced?.[1]?.trim() ?? trimmed;
  const start = source.indexOf('{');
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return undefined;
}

function repairAnalysisOutput(root: Record<string, unknown>): unknown {
  return {
    version: normalizeVersion(root.version),
    synopsis: readText(root, ['synopsis', 'summary', 'description']),
    language: readText(root, ['language', 'lang']) || 'unknown',
    entities: repairCollection(root.entities, repairAnalyzedEntity),
    concepts: repairCollection(root.concepts, repairAnalyzedConcept),
    claims: repairCollection(root.claims, repairClaim),
    relations: repairCollection(root.relations, repairRelation),
    comparisons: repairCollection(root.comparisons, repairComparison),
    contradictions: repairCollection(root.contradictions, repairContradiction),
  };
}

function repairGenerationOutput(root: Record<string, unknown>): unknown {
  return {
    version: normalizeVersion(root.version),
    artifacts: repairCollection(
      root.artifacts ?? root.pages ?? root.documents,
      repairGeneratedArtifact,
    ),
  };
}

function repairAnalyzedEntity(value: unknown): unknown {
  const item = asRecord(value);
  if (!item) return undefined;
  const canonicalKey = repairCanonicalKey(
    readText(item, ['canonicalKey', 'canonical_key', 'key', 'slug']),
  );
  const name = readText(item, ['name', 'title', 'label']);
  const description = readText(item, ['description', 'summary', 'markdown']);
  if (!canonicalKey || !name || !description) return undefined;
  return {
    canonicalKey,
    name,
    ...(readText(item, ['type', 'entityType', 'entity_type'])
      ? { type: readText(item, ['type', 'entityType', 'entity_type']) }
      : {}),
    description,
    evidenceQuotes: repairStringArray(
      item.evidenceQuotes ?? item.evidence_quotes ?? item.quotes,
    ),
  };
}

function repairAnalyzedConcept(value: unknown): unknown {
  const item = asRecord(value);
  if (!item) return undefined;
  const canonicalKey = repairCanonicalKey(
    readText(item, ['canonicalKey', 'canonical_key', 'key', 'slug']),
  );
  const name = readText(item, ['name', 'title', 'label']);
  const description = readText(item, ['description', 'summary', 'markdown']);
  if (!canonicalKey || !name || !description) return undefined;
  return {
    canonicalKey,
    name,
    description,
    evidenceQuotes: repairStringArray(
      item.evidenceQuotes ?? item.evidence_quotes ?? item.quotes,
    ),
  };
}

function repairClaim(value: unknown): unknown {
  const item = asRecord(value);
  if (!item) return undefined;
  const text = readText(item, ['text', 'claim', 'statement']);
  const evidenceQuote = readText(item, [
    'evidenceQuote',
    'evidence_quote',
    'quote',
    'evidence',
  ]);
  if (!text || !evidenceQuote) return undefined;
  const confidence = normalizeConfidence(item.confidence);
  return {
    text,
    ...(confidence === undefined ? {} : { confidence }),
    evidenceQuote,
  };
}

function repairRelation(value: unknown): unknown {
  const item = asRecord(value);
  if (!item) return undefined;
  const fromCanonicalKey = repairCanonicalKey(
    readText(item, [
      'fromCanonicalKey',
      'from_canonical_key',
      'from',
      'source',
    ]),
  );
  const toCanonicalKey = repairCanonicalKey(
    readText(item, ['toCanonicalKey', 'to_canonical_key', 'to', 'target']),
  );
  const relation = readText(item, ['relation', 'type', 'label']);
  if (!fromCanonicalKey || !toCanonicalKey || !relation) return undefined;
  const evidenceQuote = readText(item, [
    'evidenceQuote',
    'evidence_quote',
    'quote',
  ]);
  return {
    fromCanonicalKey,
    toCanonicalKey,
    relation,
    ...(evidenceQuote ? { evidenceQuote } : {}),
  };
}

function repairComparison(value: unknown): unknown {
  const item = asRecord(value);
  if (!item) return undefined;
  const canonicalKey = repairCanonicalKey(
    readText(item, ['canonicalKey', 'canonical_key', 'key', 'slug']),
  );
  const title = readText(item, ['title', 'name']);
  const subjects = repairStringArray(item.subjects)
    .map(repairCanonicalKey)
    .filter((entry): entry is string => Boolean(entry));
  const summary = readText(item, ['summary', 'description', 'markdown']);
  if (!canonicalKey || !title || subjects.length < 2 || !summary) {
    return undefined;
  }
  return {
    canonicalKey,
    title,
    subjects,
    summary,
    evidenceQuotes: repairStringArray(
      item.evidenceQuotes ?? item.evidence_quotes ?? item.quotes,
    ),
  };
}

function repairContradiction(value: unknown): unknown {
  const item = asRecord(value);
  if (!item) return undefined;
  const description = readText(item, ['description', 'summary', 'text']);
  if (!description) return undefined;
  return {
    description,
    relatedCanonicalKeys: repairStringArray(
      item.relatedCanonicalKeys ?? item.related_canonical_keys ?? item.related,
    )
      .map(repairCanonicalKey)
      .filter((entry): entry is string => Boolean(entry)),
    evidenceQuotes: repairStringArray(
      item.evidenceQuotes ?? item.evidence_quotes ?? item.quotes,
    ),
  };
}

function repairGeneratedArtifact(value: unknown): unknown {
  const item = asRecord(value);
  if (!item) return undefined;
  const kind = repairArtifactKind(
    readText(item, ['kind', 'artifactKind', 'artifact_kind', 'type']),
  );
  const canonicalKey = repairCanonicalKey(
    readText(item, ['canonicalKey', 'canonical_key', 'key', 'slug']),
  );
  const title = readText(item, ['title', 'name', 'label']);
  const markdown = readText(item, [
    'markdown',
    'body',
    'content',
    'summary',
    'description',
  ]);
  if (!kind || !canonicalKey || !title || !markdown) return undefined;
  return {
    kind,
    canonicalKey,
    title,
    markdown,
    claims: repairCollection(item.claims, repairClaim),
    links: repairCollection(item.links, repairGeneratedLink),
    tags: repairStringArray(item.tags),
  };
}

function repairGeneratedLink(value: unknown): unknown {
  const item = asRecord(value);
  if (!item) return undefined;
  const targetKind = repairArtifactKind(
    readText(item, ['targetKind', 'target_kind', 'kind', 'type']),
  );
  const targetCanonicalKey = repairCanonicalKey(
    readText(item, [
      'targetCanonicalKey',
      'target_canonical_key',
      'target',
      'canonicalKey',
    ]),
  );
  const relation = readText(item, ['relation', 'label', 'linkType']);
  if (!targetKind || !targetCanonicalKey || !relation) return undefined;
  const evidenceQuote = readText(item, [
    'evidenceQuote',
    'evidence_quote',
    'quote',
  ]);
  return {
    targetKind,
    targetCanonicalKey,
    relation,
    ...(evidenceQuote ? { evidenceQuote } : {}),
  };
}

function repairCollection(
  value: unknown,
  repair: (entry: unknown) => unknown,
): unknown[] {
  const entries = Array.isArray(value) ? value : value == null ? [] : [value];
  return entries.map(repair).filter((entry) => entry !== undefined);
}

function repairStringArray(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value == null ? [] : [value];
  return entries
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function repairArtifactKind(
  value: string,
): 'source_summary' | 'concept' | 'entity' | 'comparison' | undefined {
  const normalized = value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[\s-]+/g, '_');
  if (
    normalized === 'source_summary' ||
    normalized === 'source' ||
    normalized === 'summary' ||
    normalized === 'page'
  ) {
    return 'source_summary';
  }
  if (
    normalized === 'concept' ||
    normalized === 'entity' ||
    normalized === 'comparison'
  ) {
    return normalized;
  }
  return undefined;
}

function repairCanonicalKey(value: string): string | undefined {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[\s/\\]+/gu, '-')
    .replace(/[^\p{L}\p{N}._:-]+/gu, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/[-_.:]+$/g, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .slice(0, 160);
  return normalized || undefined;
}

function normalizeVersion(value: unknown): '1' {
  void value;
  return '1';
}

function normalizeConfidence(value: unknown): number | undefined {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : undefined;
  if (number === undefined || !Number.isFinite(number)) return undefined;
  return Math.max(0, Math.min(1, number));
}

function readText(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === 'string' && entry.trim()) return entry.trim();
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
