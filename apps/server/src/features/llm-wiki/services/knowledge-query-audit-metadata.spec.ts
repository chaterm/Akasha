import { buildKnowledgeQueryAuditMetadata } from './knowledge-query-audit-metadata';

describe('buildKnowledgeQueryAuditMetadata', () => {
  it('maps diagnostics and query observation into common audit fields', () => {
    expect(
      buildKnowledgeQueryAuditMetadata({
        answerMode: 'general',
        queryObservation: {
          decisionReason: 'model_general',
          generalAnswerReason: 'The retrieved evidence is unrelated.',
          finalChunkIds: ['chunk-1'],
          finalSourcePageIds: ['page-1'],
          rankReasonsByChunk: { 'chunk-1': ['semantic'] },
          contextItems: [
            {
              itemId: 'chunk-1',
              kind: 'chunk',
              disposition: 'clipped',
              originalChars: 20,
              includedChars: 10,
            },
          ],
          packContextLength: 20,
          packMaxContextLength: 12000,
          answerContextLength: 48,
          answerContextHash: `sha256:${'a'.repeat(64)}`,
        },
        retrievalDiagnostics: {
          queryEmbeddingAvailable: true,
          candidateSourceCount: 3,
          policyCandidateSourceCount: 2,
          fallbackCandidateSourceCount: 1,
          finalAuthorizedSourceCount: 1,
          accessPolicyFallbackUsed: false,
          candidateChunkCount: 4,
          rankedCandidateCount: 3,
          authorizedChunkCount: 2,
          filteredChunkCount: 1,
        },
      }),
    ).toEqual({
      answerMode: 'general',
      decisionReason: 'model_general',
      generalAnswerReason: 'The retrieved evidence is unrelated.',
      queryEmbeddingAvailable: true,
      candidateSourceCount: 3,
      policyCandidateSourceCount: 2,
      fallbackCandidateSourceCount: 1,
      finalAuthorizedSourceCount: 1,
      accessPolicyFallbackUsed: false,
      candidateChunkCount: 4,
      rankedCandidateCount: 3,
      authorizedChunkCount: 2,
      filteredChunkCount: 1,
      finalChunkIds: ['chunk-1'],
      finalSourcePageIds: ['page-1'],
      rankReasonsByChunk: { 'chunk-1': ['semantic'] },
      contextItems: [
        {
          itemId: 'chunk-1',
          kind: 'chunk',
          disposition: 'clipped',
          originalChars: 20,
          includedChars: 10,
        },
      ],
      packContextLength: 20,
      packMaxContextLength: 12000,
      answerContextLength: 48,
      answerContextHash: `sha256:${'a'.repeat(64)}`,
    });
  });

  it('uses zero diagnostics for explicit general queries', () => {
    expect(
      buildKnowledgeQueryAuditMetadata({
        answerMode: 'general',
        queryObservation: {
          decisionReason: 'explicit_general',
          finalChunkIds: [],
          finalSourcePageIds: [],
          rankReasonsByChunk: {},
          contextItems: [],
          packContextLength: 0,
          packMaxContextLength: 0,
          answerContextLength: null,
          answerContextHash: null,
        },
      }),
    ).toMatchObject({
      decisionReason: 'explicit_general',
      candidateChunkCount: 0,
      authorizedChunkCount: 0,
      answerContextLength: null,
      answerContextHash: null,
    });
  });

  it('persists raw retrieval scores and exact packed context items', () => {
    const result = buildKnowledgeQueryAuditMetadata({
      answerMode: 'knowledge',
      queryObservation: {
        decisionReason: 'knowledge',
        finalChunkIds: ['chunk-1'],
        finalSourcePageIds: ['page-1'],
        rankReasonsByChunk: { 'chunk-1': ['semantic'] },
        contextItems: [],
        packContextLength: 24,
        packMaxContextLength: 12000,
        answerContextLength: 24,
        answerContextHash: `sha256:${'b'.repeat(64)}`,
      },
      retrieval: {
        attempted: true,
        topK: 20,
        threshold: 0.45,
        candidates: [
          {
            pageId: 'page-1',
            chunkId: 'chunk-1',
            score: 0.12,
            scoreType: 'semantic_distance',
            reasons: ['semantic'],
            stage: 'direct',
            authorizationMode: 'policy',
          },
        ],
        dropped: [],
      },
      context: {
        text: '# Page 1\nExact context',
        items: [
          {
            itemId: 'chunk-1',
            pageId: 'page-1',
            text: 'Exact context',
            tokenCount: 4,
          },
        ],
        usedTokens: 4,
        maxTokens: 3000,
        dropped: [
          {
            itemId: 'chunk-2',
            pageId: 'page-2',
            reason: 'below_threshold',
          },
        ],
      },
    });

    expect(result).toMatchObject({
      retrieval: {
        threshold: 0.45,
        candidates: [
          expect.objectContaining({
            chunkId: 'chunk-1',
            scoreType: 'semantic_distance',
          }),
        ],
      },
      context: {
        items: [
          {
            itemId: 'chunk-1',
            pageId: 'page-1',
            text: 'Exact context',
            tokenCount: 4,
          },
        ],
        dropped: [
          expect.objectContaining({
            itemId: 'chunk-2',
            pageId: 'page-2',
            reason: 'below_threshold',
          }),
        ],
      },
    });
  });

  it('persists the compact graph retrieval summary', () => {
    const result = buildKnowledgeQueryAuditMetadata({
      answerMode: 'knowledge',
      queryObservation: {
        decisionReason: 'knowledge',
        finalChunkIds: ['chunk-1'],
        finalSourcePageIds: ['page-1'],
        rankReasonsByChunk: { 'chunk-1': ['semantic'] },
        contextItems: [],
        packContextLength: 10,
        packMaxContextLength: 12000,
        answerContextLength: 10,
        answerContextHash: null,
      },
      retrievalDiagnostics: {
        queryEmbeddingAvailable: true,
        candidateSourceCount: 1,
        policyCandidateSourceCount: 1,
        fallbackCandidateSourceCount: 0,
        finalAuthorizedSourceCount: 1,
        accessPolicyFallbackUsed: false,
        candidateChunkCount: 2,
        rankedCandidateCount: 2,
        authorizedChunkCount: 1,
        filteredChunkCount: 1,
        graph: {
          candidateCount: 3,
          gatedOutCount: 1,
          selectedCount: 1,
          expandedSeedCount: 2,
          edgeCounts: { link: 1, 'shared-source': 0 },
          pageCountsByHop: { 1: 2, 2: 1 },
        },
      },
    });

    expect(result.graph).toEqual({
      candidateCount: 3,
      gatedOutCount: 1,
      selectedCount: 1,
      expandedSeedCount: 2,
      edgeCounts: { link: 1, 'shared-source': 0 },
      pageCountsByHop: { 1: 2, 2: 1 },
    });
  });
});
