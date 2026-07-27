import {
  buildKnowledgeAdminActionJobId,
  buildKnowledgeAggregateSpaceJobId,
  buildKnowledgeCompileCoalesceKey,
  buildKnowledgeCompileJobId,
  buildKnowledgeRetryPageJobId,
  buildKnowledgeRunKey,
  KNOWLEDGE_COMPILE_RETRY_BACKOFF_MS,
} from './knowledge-queue.utils';

describe('knowledge queue utils', () => {
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
});
