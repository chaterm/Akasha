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

const evidenceQuotesSchema = z.array(z.string().trim().min(1)).max(20);

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
    version: z.literal('1'),
    synopsis: z.string().trim().min(1),
    language: z.string().trim().min(1),
    entities: z.array(analyzedEntitySchema).max(100).default([]),
    concepts: z.array(analyzedConceptSchema).max(100).default([]),
    claims: z.array(analyzedClaimSchema).max(200).default([]),
    relations: z.array(analyzedRelationSchema).max(200).default([]),
    comparisons: z.array(analyzedComparisonSchema).max(50).default([]),
    contradictions: z
      .array(analyzedContradictionSchema)
      .max(50)
      .default([]),
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
    claims: z.array(generatedClaimSchema).max(200).default([]),
    links: z.array(generatedLinkSchema).max(200).default([]),
    tags: z.array(z.string().trim().min(1)).max(50).default([]),
  })
  .strict();

export type SemanticGeneratedArtifact = z.infer<
  typeof semanticGeneratedArtifactSchema
>;

export const semanticGenerationSchema = z
  .object({
    version: z.literal('1'),
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
