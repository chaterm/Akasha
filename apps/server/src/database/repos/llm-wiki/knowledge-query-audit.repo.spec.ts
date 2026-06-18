import { KnowledgeQueryAuditRepo } from './knowledge-query-audit.repo';

type QueryCall = {
  method: string;
  args: unknown[];
};

class FakeKyselyQuery {
  readonly calls: QueryCall[] = [];

  constructor(private readonly result: unknown[] = []) {}

  insertInto(...args: unknown[]) {
    this.calls.push({ method: 'insertInto', args });
    return this;
  }

  values(...args: unknown[]) {
    this.calls.push({ method: 'values', args });
    return this;
  }

  selectFrom(...args: unknown[]) {
    this.calls.push({ method: 'selectFrom', args });
    return this;
  }

  select(...args: unknown[]) {
    this.calls.push({ method: 'select', args });
    return this;
  }

  where(...args: unknown[]) {
    this.calls.push({ method: 'where', args });
    return this;
  }

  orderBy(...args: unknown[]) {
    this.calls.push({ method: 'orderBy', args });
    return this;
  }

  limit(...args: unknown[]) {
    this.calls.push({ method: 'limit', args });
    return this;
  }

  async execute() {
    this.calls.push({ method: 'execute', args: [] });
    return this.result;
  }
}

describe('KnowledgeQueryAuditRepo', () => {
  it('records hashed query retrieval diagnostics without raw query text', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeQueryAuditRepo(query as never);

    await repo.recordQuery({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      queryHash: 'sha256:abc',
      retrievalMode: 'high_completeness',
      authorizedCapsuleCount: 2,
      metadata: {
        spaceIds: ['space-1'],
        queryEmbeddingAvailable: false,
        candidateSourceCount: 4,
        sidecarEligibleSourceCount: 2,
        sidecarFallbackSourceCount: 0,
        sidecarFilteredSourceCount: 2,
        candidateChunkCount: 3,
        rankedCandidateCount: 3,
        authorizedChunkCount: 2,
        filteredChunkCount: 1,
      },
    });

    expect(query.calls).toEqual([
      { method: 'insertInto', args: ['knowledgeQueryAudit'] },
      {
        method: 'values',
        args: [
          {
            workspaceId: 'workspace-1',
            userId: 'user-1',
            queryHash: 'sha256:abc',
            retrievalMode: 'high_completeness',
            authorizedCapsuleCount: 2,
            metadata: {
              spaceIds: ['space-1'],
              queryEmbeddingAvailable: false,
              candidateSourceCount: 4,
              sidecarEligibleSourceCount: 2,
              sidecarFallbackSourceCount: 0,
              sidecarFilteredSourceCount: 2,
              candidateChunkCount: 3,
              rankedCandidateCount: 3,
              authorizedChunkCount: 2,
              filteredChunkCount: 1,
            },
          },
        ],
      },
      { method: 'execute', args: [] },
    ]);
    expect(JSON.stringify(query.calls)).not.toContain('How do we use Kafka?');
  });

  it('summarizes recent retrieval diagnostics for admin health panels', async () => {
    const query = new FakeKyselyQuery([
      {
        authorizedCapsuleCount: 0,
        metadata: {
          queryEmbeddingAvailable: false,
          authorizedChunkCount: 0,
          filteredChunkCount: 3,
        },
      },
      {
        authorizedCapsuleCount: 3,
        metadata: {
          queryEmbeddingAvailable: true,
          authorizedChunkCount: 3,
          filteredChunkCount: 1,
        },
      },
    ]);
    const repo = new KnowledgeQueryAuditRepo(query as never);

    await expect(
      repo.summarizeWorkspace({
        workspaceId: 'workspace-1',
        limit: 20,
      }),
    ).resolves.toEqual({
      sampleCount: 2,
      zeroHitRate: 0.5,
      embeddingFallbackRate: 0.5,
      averageAuthorizedCandidateCount: 1.5,
      averageFilteredCandidateCount: 2,
    });

    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['knowledgeQueryAudit'] },
      {
        method: 'select',
        args: [['authorizedCapsuleCount', 'metadata']],
      },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'orderBy', args: ['createdAt', 'desc'] },
      { method: 'limit', args: [20] },
      { method: 'execute', args: [] },
    ]);
  });
});
