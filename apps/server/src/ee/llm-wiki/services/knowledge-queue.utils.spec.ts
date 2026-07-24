import {
  buildKnowledgeAdminActionJobId,
  buildKnowledgeAggregateSpaceJobId,
  buildKnowledgeCompileCoalesceKey,
  buildKnowledgeCompileJobId,
  buildKnowledgeRunKey,
} from './knowledge-queue.utils';

describe('knowledge queue utils', () => {
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
});
