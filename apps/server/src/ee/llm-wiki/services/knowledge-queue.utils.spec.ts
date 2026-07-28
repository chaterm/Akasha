import {
  buildKnowledgeAdminActionJobId,
  buildKnowledgeAggregateSpaceJobId,
  buildKnowledgeCompileCoalesceKey,
  buildKnowledgeCompileJobId,
  buildKnowledgeCompilePageImagesJobId,
  buildKnowledgeMergePageImagesJobId,
  buildKnowledgeRetryPageJobId,
  buildKnowledgeRunKey,
  KNOWLEDGE_COMPILE_RETRY_BACKOFF_MS,
} from './knowledge-queue.utils';

describe('knowledge queue utils', () => {
  it('builds one deterministic merge job id for an effective page snapshot', () => {
    const input = {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      runId: 'run-1',
      sourcePageId: 'page-1',
      sourceContentHash: 'sha256:page-v2',
      effectiveKnowledgeHash: 'sha256:page-v2-with-images',
      knowledgeGeneration: 7,
    };

    const first = buildKnowledgeMergePageImagesJobId(input);
    const duplicate = buildKnowledgeMergePageImagesJobId(input);
    const changed = buildKnowledgeMergePageImagesJobId({
      ...input,
      effectiveKnowledgeHash: 'sha256:page-v2-with-new-images',
    });

    expect(first).toBe(duplicate);
    expect(changed).not.toBe(first);
    expect(first).toMatch(
      /^knowledge-merge-page-images__workspace-1__space-1__run-1__page-1__7__[a-f0-9]{64}__[a-f0-9]{64}$/,
    );
    expect(first).not.toContain(':');
  });

  it('separates initial and final aggregate job identities', () => {
    expect(
      buildKnowledgeAggregateSpaceJobId({
        runId: 'run-1',
        phase: 'initial_aggregate',
      }),
    ).toBe('knowledge-aggregate-space__run-1__initial_aggregate');
    expect(
      buildKnowledgeAggregateSpaceJobId({
        runId: 'run-1',
        phase: 'final_aggregate',
      }),
    ).toBe('knowledge-aggregate-space__run-1__final_aggregate');
  });
  it('builds one deterministic image job id for a page snapshot and generation', () => {
    const first = buildKnowledgeCompilePageImagesJobId({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      runId: 'run-1',
      sourcePageId: 'page-1',
      sourceContentHash: 'sha256:page-v2',
      knowledgeGeneration: 7,
    });
    const duplicate = buildKnowledgeCompilePageImagesJobId({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      runId: 'run-1',
      sourcePageId: 'page-1',
      sourceContentHash: 'sha256:page-v2',
      knowledgeGeneration: 7,
    });

    expect(first).toBe(duplicate);
    expect(first).toMatch(
      /^knowledge-compile-page-images__workspace-1__space-1__run-1__page-1__7__[a-f0-9]{64}$/,
    );
    expect(first).not.toContain(':');
  });

  it('keeps page retries beyond the image extraction retry window', () => {
    expect(KNOWLEDGE_COMPILE_RETRY_BACKOFF_MS).toBeGreaterThan(30_000);
    expect(KNOWLEDGE_COMPILE_RETRY_BACKOFF_MS * 2).toBeGreaterThan(60_000);
  });

  it('builds BullMQ-safe custom job ids without colon separators', () => {
    const ids = [
      buildKnowledgeCompileJobId({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        runKey: buildKnowledgeRunKey('retry_compile', 123),
      }),
      buildKnowledgeAggregateSpaceJobId({ runId: 'run-1' }),
      buildKnowledgeAdminActionJobId({
        action: 'reindex_access',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        now: 123,
      }),
      buildKnowledgeCompileJobId({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        runKey: buildKnowledgeCompileCoalesceKey(10_000, 5_000),
      }),
    ];

    expect(ids).toEqual([
      expect.stringMatching(/^knowledge-compile-space__workspace-1__space-1__/),
      'knowledge-aggregate-space__run-1',
      expect.stringMatching(
        /^knowledge-reindex-access__workspace-1__space-1__/,
      ),
      'knowledge-compile-space__workspace-1__space-1__page-update-2',
    ]);
    for (const id of ids) {
      expect(id).not.toContain(':');
    }
  });

  it('builds a stable retry job id from the page content hash', () => {
    const first = buildKnowledgeRetryPageJobId({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      sourceContentHash: 'sha256:content-1',
    });
    const duplicate = buildKnowledgeRetryPageJobId({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      sourceContentHash: 'sha256:content-1',
    });
    const changed = buildKnowledgeRetryPageJobId({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      sourceContentHash: 'sha256:content-2',
    });

    expect(first).toBe(duplicate);
    expect(changed).not.toBe(first);
    expect(first).toMatch(
      /^knowledge-retry-page__workspace-1__space-1__page-1__[a-f0-9]{64}$/,
    );
    expect(first).not.toContain(':');
  });

  it('coalesces concurrent embedding rebuild requests for the same Space', () => {
    const first = buildKnowledgeAdminActionJobId({
      action: 'rebuild_embeddings',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      now: 123,
    });
    const duplicate = buildKnowledgeAdminActionJobId({
      action: 'rebuild_embeddings',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      now: 456,
    });

    expect(first).toBe(duplicate);
    expect(first).toBe('knowledge-rebuild-embeddings__workspace-1__space-1');
  });
});
