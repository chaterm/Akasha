import { z } from 'zod';

export const reviewTypeSchema = z.enum([
  'missing-page',
  'suggestion',
  'contradiction',
  'duplicate',
]);
export type ReviewType = z.infer<typeof reviewTypeSchema>;

const reviewBaseFields = {
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  recommendation: z.string(),
};

export const missingPageReviewSchema = z.object({
  ...reviewBaseFields,
  type: z.literal('missing-page'),
  relatedDocIds: z.array(z.string()).default([]),
  searchQueries: z.array(z.string()).default([]),
  outline: z.array(z.string()).default([]),
});

export const suggestionReviewSchema = z.object({
  ...reviewBaseFields,
  type: z.literal('suggestion'),
  relatedDocIds: z.array(z.string()).default([]),
  searchQueries: z.array(z.string()).default([]),
  targetDocId: z.string().nullable().default(null),
});

export const contradictionReviewSchema = z.object({
  ...reviewBaseFields,
  type: z.literal('contradiction'),
  relatedDocIds: z.array(z.string()).default([]),
  searchQueries: z.array(z.string()).default([]),
});

export const duplicateReviewSchema = z.object({
  ...reviewBaseFields,
  type: z.literal('duplicate'),
  relatedDocIds: z.array(z.string()).default([]),
  suggestedPrimaryId: z.string().nullable().default(null),
  searchQueries: z.array(z.string()).default([]),
});

export const reviewItemSchema = z.discriminatedUnion('type', [
  missingPageReviewSchema,
  suggestionReviewSchema,
  contradictionReviewSchema,
  duplicateReviewSchema,
]);
export type ReviewItem = z.infer<typeof reviewItemSchema>;

export const reviewResultSchema = z.object({
  version: z.literal('2').default('2'),
  items: z.array(reviewItemSchema).default([]),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;

export const reviewDocMetaSchema = z.object({
  id: z.string(),
  title: z.string(),
  sourcePageId: z.string().optional(),
});
export type ReviewDocMeta = z.infer<typeof reviewDocMetaSchema>;

export const QUICK_ACTIONS = ['DeepSearch', '采纳', '暂时跳过'] as const;
export type QuickAction = (typeof QUICK_ACTIONS)[number];

export const draftApplyOperationSchema = z.enum([
  'create-page',
  'append-section',
  'replace-page',
  'rename-page',
]);
export type DraftApplyOperation = z.infer<typeof draftApplyOperationSchema>;

// AI 在协商阶段给出的"写动作"意图。允许 1-2 个动作,例如 rename-page + replace-page。
// 兼容旧 snapshot: 老数据里的单个字符串会被转换成数组。
export const draftApplyOperationsSchema = z.preprocess(
  (value) => (Array.isArray(value) ? value : value ? [value] : value),
  z
    .array(draftApplyOperationSchema)
    .min(1)
    .max(2)
    .transform((operations) => [...new Set(operations)]),
);
export type DraftApplyOperations = z.infer<typeof draftApplyOperationsSchema>;

export const draftContentSchema = z.preprocess(
  (value) => {
    if (!isRecord(value) || value.applyOperation) {
      return value;
    }
    const applyOperation = legacyApproachToApplyOperations(value.approach);
    return applyOperation ? { ...value, applyOperation } : value;
  },
  z.object({
    title: z.string(),
    body: z.string(),
    // AI 给出的落地写动作。代码会按 review type 兜底纠正。
    applyOperation: draftApplyOperationsSchema,
    targetDocId: z.string().nullable().default(null),
    notes: z.string().default(''),
  }),
);
export type DraftContent = z.infer<typeof draftContentSchema>;

function legacyApproachToApplyOperations(
  approach: unknown,
): DraftApplyOperation[] | null {
  switch (approach) {
    case 'new-page':
    case 'clarify':
      return ['create-page'];
    case 'section':
      return ['append-section'];
    case 'rewrite':
    case 'merge':
      return ['replace-page'];
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const appliedReviewResultSchema = z.object({
  pageId: z.string(),
  pageTitle: z.string(),
  pageSlugId: z.string(),
  spaceSlug: z.string().nullable().default(null),
  action: z.enum(['created', 'updated']),
});
export type AppliedReviewResult = z.infer<typeof appliedReviewResultSchema>;

export const reviewApplyOperationSchema = z.enum([
  'create_page',
  'insert_under_heading',
  'replace_section',
  'append_section',
  'replace_page',
  'rename_page',
  'rewrite_page',
  'merge_pages',
]);
export type ReviewApplyOperation = z.infer<typeof reviewApplyOperationSchema>;

export const reviewApplicationStatusSchema = z.enum([
  'draft',
  'applied',
  'reverted',
  'conflicted',
  'failed',
]);
export type ReviewApplicationStatus = z.infer<
  typeof reviewApplicationStatusSchema
>;

export const reviewSourceRefSchema = z.object({
  type: z.enum(['wiki', 'web', 'llm']),
  title: z.string(),
  url: z.string().optional(),
  pageId: z.string().optional(),
  quote: z.string().optional(),
});
export type ReviewSourceRef = z.infer<typeof reviewSourceRefSchema>;

export const reviewApplicationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  spaceId: z.string(),
  reviewItemId: z.string(),
  status: reviewApplicationStatusSchema,
  operation: reviewApplyOperationSchema,
  targetPageId: z.string().nullable().default(null),
  targetPageTitle: z.string().nullable().default(null),
  targetHeadingPath: z.array(z.string()).default([]),
  basePageVersion: z.string().nullable().default(null),
  baseContentHash: z.string().nullable().default(null),
  beforeContent: z.string().nullable().default(null),
  afterContent: z.string(),
  afterContentHash: z.string(),
  patch: z.unknown().nullable().default(null),
  createdPageId: z.string().nullable().default(null),
  appliedAt: z.string().nullable().default(null),
  revertedAt: z.string().nullable().default(null),
  appliedBy: z.string(),
  rationale: z.string().default(''),
  sourceRefs: z.array(reviewSourceRefSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ReviewApplication = z.infer<typeof reviewApplicationSchema>;

export const reviewApplicationDiffSchema = z.object({
  application: reviewApplicationSchema,
  beforeContent: z.string().nullable().default(null),
  afterContent: z.string(),
});
export type ReviewApplicationDiff = z.infer<typeof reviewApplicationDiffSchema>;

export const searchResultSchema = z.object({
  query: z.string(),
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
});
export type ReviewSearchResult = z.infer<typeof searchResultSchema>;

export const negotiationTurnSchema = z.object({
  feedback: z.string(),
  draft: draftContentSchema,
  deepSearched: z.boolean().default(false),
  searchResults: z.array(searchResultSchema).default([]),
});
export type NegotiationTurn = z.infer<typeof negotiationTurnSchema>;

export const resolvedReviewSchema = z.preprocess(
  (value) => {
    if (!isRecord(value)) {
      return value;
    }
    if (Array.isArray(value.turns)) {
      return value;
    }
    if (!value.draft) {
      return { ...value, turns: [] };
    }
    return {
      ...value,
      turns: [
        {
          feedback: typeof value.feedback === 'string' ? value.feedback : '',
          draft: value.draft,
          deepSearched:
            typeof value.deepSearched === 'boolean'
              ? value.deepSearched
              : false,
          searchResults: Array.isArray(value.searchResults)
            ? value.searchResults
            : [],
        },
      ],
    };
  },
  z
    .object({
      item: reviewItemSchema,
      feedback: z.string(),
      skipped: z.boolean(),
      deepSearched: z.boolean(),
      searchResults: z.array(searchResultSchema).default([]),
      draft: draftContentSchema.nullable().default(null),
      applied: appliedReviewResultSchema.nullable().default(null),
      turns: z.array(negotiationTurnSchema).default([]),
    })
    .transform((resolved) => {
      const latestTurn = resolved.turns[resolved.turns.length - 1];
      if (!latestTurn) {
        return resolved;
      }
      return {
        ...resolved,
        feedback: latestTurn.feedback,
        deepSearched: latestTurn.deepSearched,
        searchResults: latestTurn.searchResults,
        draft: latestTurn.draft,
      };
    }),
);
export type StoredResolvedReview = z.infer<typeof resolvedReviewSchema>;

export const reviewSnapshotSchema = z.object({
  version: z.literal('2').default('2'),
  items: z.array(reviewItemSchema).default([]),
  docs: z.array(reviewDocMetaSchema).default([]),
  resolvedReviews: z.array(resolvedReviewSchema).default([]),
  applications: z.array(reviewApplicationSchema).default([]),
  discoveredAt: z.string(),
  updatedAt: z.string(),
});
export type ReviewSnapshot = z.infer<typeof reviewSnapshotSchema>;
