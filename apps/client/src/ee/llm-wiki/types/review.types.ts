export type ReviewType =
  | "missing-page"
  | "suggestion"
  | "contradiction"
  | "duplicate";

interface ReviewItemBase {
  id: string;
  title: string;
  detail: string;
  recommendation: string;
  relatedDocIds: string[];
  searchQueries: string[];
}

export interface MissingPageReviewItem extends ReviewItemBase {
  type: "missing-page";
  outline: string[];
}

export interface SuggestionReviewItem extends ReviewItemBase {
  type: "suggestion";
  targetDocId: string | null;
}

export interface ContradictionReviewItem extends ReviewItemBase {
  type: "contradiction";
}

export interface DuplicateReviewItem extends ReviewItemBase {
  type: "duplicate";
  suggestedPrimaryId: string | null;
}

export type ReviewItem =
  | MissingPageReviewItem
  | SuggestionReviewItem
  | ContradictionReviewItem
  | DuplicateReviewItem;

export interface ReviewDocMeta {
  id: string;
  title: string;
  sourcePageId?: string;
}

export interface ReviewSnapshot {
  version: "2";
  items: ReviewItem[];
  docs: ReviewDocMeta[];
  resolvedReviews: ResolvedReview[];
  applications: ReviewApplication[];
  discoveredAt: string;
  updatedAt: string;
}

export type DraftApproach =
  | "new-page"
  | "section"
  | "rewrite"
  | "clarify"
  | "merge";

export type DraftApplyOperation =
  | "create-page"
  | "append-section"
  | "replace-page"
  | "rename-page";

export interface DraftContent {
  title: string;
  body: string;
  approach: DraftApproach;
  applyOperation?: DraftApplyOperation;
  targetDocId: string | null;
  notes: string;
}

export interface AppliedReviewResult {
  pageId: string;
  pageTitle: string;
  pageSlugId: string;
  spaceSlug: string | null;
  action: "created" | "updated";
}

export interface SearchResult {
  query: string;
  title: string;
  url: string;
  snippet: string;
}

export type ReviewApplyOperation =
  | "create_page"
  | "insert_under_heading"
  | "replace_section"
  | "append_section"
  | "replace_page"
  | "rename_page"
  | "rewrite_page"
  | "merge_pages";

export type ReviewApplicationStatus =
  | "draft"
  | "applied"
  | "reverted"
  | "conflicted"
  | "failed";

export interface ReviewSourceRef {
  type: "wiki" | "web" | "llm";
  title: string;
  url?: string;
  pageId?: string;
  quote?: string;
}

export interface ReviewApplication {
  id: string;
  workspaceId: string;
  spaceId: string;
  reviewItemId: string;
  status: ReviewApplicationStatus;
  operation: ReviewApplyOperation;
  targetPageId: string | null;
  targetPageTitle: string | null;
  targetHeadingPath: string[];
  basePageVersion: string | null;
  baseContentHash: string | null;
  beforeContent: string | null;
  afterContent: string;
  afterContentHash: string;
  patch: unknown | null;
  createdPageId: string | null;
  appliedAt: string | null;
  revertedAt: string | null;
  appliedBy: string;
  rationale: string;
  sourceRefs: ReviewSourceRef[];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewApplicationDiff {
  application: ReviewApplication;
  beforeContent: string | null;
  afterContent: string;
}

export interface ResolvedReview {
  item: ReviewItem;
  feedback: string;
  skipped: boolean;
  deepSearched: boolean;
  searchResults: SearchResult[];
  draft: DraftContent | null;
  applied: AppliedReviewResult | null;
}
