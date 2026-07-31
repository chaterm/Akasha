import {
  KNOWLEDGE_COMPILE_RETRY_BACKOFF_MS,
  buildKnowledgeAdminActionJobId,
  buildKnowledgeRebuildEmbeddingsContinuationJobId,
  buildKnowledgeReindexAccessContinuationJobId,
  buildReviewDiscoverJobId,
  buildReviewNegotiateJobId,
  uniqueValues,
} from './knowledge-queue.utils';

describe('knowledge queue utils', () => {
  it('keeps image retries beyond the extraction lease window', () => {
    expect(KNOWLEDGE_COMPILE_RETRY_BACKOFF_MS).toBeGreaterThan(30_000);
  });

  it('builds deterministic BullMQ-safe maintenance and review IDs', () => {
    const ids = [
      buildKnowledgeAdminActionJobId({
        action: 'rebuild_embeddings',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
      buildKnowledgeRebuildEmbeddingsContinuationJobId({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        afterChunkId: 'chunk:1',
      }),
      buildKnowledgeReindexAccessContinuationJobId({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        afterSourcePageId: 'page:1',
      }),
      buildReviewDiscoverJobId({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
      buildReviewNegotiateJobId({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        itemId: 'item-1',
      }),
    ];

    expect(ids[0]).toBe('knowledge-rebuild-embeddings__workspace-1__space-1');
    expect(ids.every((id) => !id.includes(':'))).toBe(true);
  });

  it('deduplicates non-empty values without changing order', () => {
    expect(uniqueValues(['space-1', '', 'space-2', 'space-1'])).toEqual([
      'space-1',
      'space-2',
    ]);
  });
});
