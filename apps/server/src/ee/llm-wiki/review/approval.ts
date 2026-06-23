import { SearchProvider, SearchResult } from './search-provider';
import { ReviewService } from './review.service';
import { AppliedReviewResult, DraftContent, ReviewItem } from './review.schema';
import { WikiSource } from './wiki-source';

export const SKIP_FEEDBACK = '暂时跳过';
export const DEEPSEARCH_FEEDBACK = 'DeepSearch';

export type FeedbackFn = (item: ReviewItem) => Promise<string> | string;

export type ResolveHooks = {
  onNegotiateStart?: (
    item: ReviewItem,
    feedback: string,
    deepSearched: boolean,
  ) => void;
  onResolved?: (resolved: ResolvedReview) => void;
};

export type ResolvedReview = {
  item: ReviewItem;
  feedback: string;
  skipped: boolean;
  deepSearched: boolean;
  searchResults: SearchResult[];
  draft: DraftContent | null;
  applied: AppliedReviewResult | null;
};

export function isSkip(feedback: string): boolean {
  const f = feedback.trim();
  return f === '' || f === SKIP_FEEDBACK;
}

export function isDeepSearch(feedback: string): boolean {
  return feedback.trim().toLowerCase() === DEEPSEARCH_FEEDBACK.toLowerCase();
}

export async function resolveReviews(
  reviewService: ReviewService,
  source: WikiSource,
  search: SearchProvider,
  items: ReviewItem[],
  feedbackFn: FeedbackFn,
  hooks: ResolveHooks = {},
): Promise<ResolvedReview[]> {
  const resolved: ResolvedReview[] = [];
  for (const item of items) {
    const feedback = (await feedbackFn(item)).trim();

    if (isSkip(feedback)) {
      const r: ResolvedReview = {
        item,
        feedback,
        skipped: true,
        deepSearched: false,
        searchResults: [],
        draft: null,
        applied: null,
      };
      resolved.push(r);
      hooks.onResolved?.(r);
      continue;
    }

    const deepSearched = isDeepSearch(feedback);
    hooks.onNegotiateStart?.(item, feedback, deepSearched);

    const searchResults = deepSearched
      ? await reviewService.runDeepSearch(search, item)
      : [];

    const draft = await reviewService.negotiateDraft(
      source,
      item,
      feedback,
      searchResults,
    );
    const r: ResolvedReview = {
      item,
      feedback,
      skipped: false,
      deepSearched,
      searchResults,
      draft,
      applied: null,
    };
    resolved.push(r);
    hooks.onResolved?.(r);
  }
  return resolved;
}
