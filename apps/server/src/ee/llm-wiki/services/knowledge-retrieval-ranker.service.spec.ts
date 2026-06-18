import { KnowledgeRetrievalRankerService } from './knowledge-retrieval-ranker.service';

describe('KnowledgeRetrievalRankerService', () => {
  it('ranks compiled chunks by semantic score and BM25 rerank, then collapses to pages', () => {
    const ranker = new KnowledgeRetrievalRankerService();

    expect(
      ranker.rankPageIds({
        query: 'AkashaQwenSmokeTest 是什么？',
        queryEmbedding: [1, 0],
        chunks: [
          chunk(
            'chunk-1',
            'kp-semantic-only',
            [1, 0],
            'Unrelated compiled chunk',
          ),
          chunk(
            'chunk-2',
            'kp-exact',
            [0.6, 0.8],
            'AkashaQwenSmokeTest retrieval behavior',
          ),
          chunk('chunk-3', 'kp-exact', [0.7, 0.7], 'AkashaQwenSmokeTest setup'),
        ],
        limit: 2,
      }),
    ).toEqual(['kp-exact', 'kp-semantic-only']);
  });

  it('drops chunks with malformed or dimension-mismatched embeddings', () => {
    const ranker = new KnowledgeRetrievalRankerService();

    expect(
      ranker.rankPageIds({
        query: 'retrieval',
        queryEmbedding: [1, 0],
        chunks: [
          chunk('chunk-1', 'kp-1', [1], 'retrieval'),
          chunk('chunk-2', 'kp-2', null, 'retrieval'),
          chunk('chunk-3', 'kp-3', [1, 0], 'retrieval'),
        ],
        limit: 10,
      }),
    ).toEqual(['kp-3']);
  });

  it('uses Chinese query terms when reranking exact factual chunks', () => {
    const ranker = new KnowledgeRetrievalRankerService();

    expect(
      ranker
        .rankChunks({
          query: 'chaterm 登记批准日期',
          queryEmbedding: [1, 0],
          chunks: [
            chunk(
              'chunk-kms',
              'kp-kms',
              [1, 0],
              'Chaterm 使用 AWS KMS 信封加密保护用户数据。',
            ),
            chunk(
              'chunk-date',
              'kp-date',
              [0.4, 0.9],
              '软件名称：合合信息Chaterm企业版软件 登记批准日期：2026年06月05日',
            ),
          ],
          limit: 2,
        })
        .map((item) => item.id),
    ).toEqual(['chunk-date', 'chunk-kms']);
  });

  it('ranks hybrid candidates without requiring query embeddings', () => {
    const ranker = new KnowledgeRetrievalRankerService();

    expect(
      ranker
        .rankHybridCandidates({
          query: 'AkashaQwenSmokeTest',
          candidates: [
            {
              chunk: chunk(
                'chunk-lexical',
                'kp-lexical',
                null,
                'AkashaQwenSmokeTest retrieval behavior',
              ),
              page: page('kp-lexical'),
              sourcePageIds: ['source-1'],
              signals: ['lexical'],
              lexicalScore: 3,
            },
            {
              chunk: chunk(
                'chunk-title',
                'kp-title',
                null,
                'General compiled summary',
              ),
              page: page('kp-title', 'AkashaQwenSmokeTest'),
              sourcePageIds: ['source-2'],
              signals: ['exact-title'],
              lexicalScore: 1,
            },
          ],
          limit: 2,
        })
        .map((candidate) => ({
          id: candidate.chunk.id,
          reasons: candidate.rankReasons,
        })),
    ).toEqual([
      {
        id: 'chunk-title',
        reasons: ['exact-title', 'sidecar-prefiltered'],
      },
      {
        id: 'chunk-lexical',
        reasons: ['lexical', 'sidecar-prefiltered'],
      },
    ]);
  });

  it('merges semantic, lexical, and title ranks with RRF', () => {
    const ranker = new KnowledgeRetrievalRankerService();

    expect(
      ranker
        .rankHybridCandidates({
          query: 'deployment',
          queryEmbedding: [1, 0],
          candidates: [
            {
              chunk: chunk('chunk-semantic', 'kp-semantic', [1, 0], 'Other'),
              page: page('kp-semantic'),
              sourcePageIds: ['source-1'],
              signals: ['semantic'],
            },
            {
              chunk: chunk(
                'chunk-combined',
                'kp-combined',
                [0.8, 0.2],
                'deployment guide',
              ),
              page: page('kp-combined', 'deployment'),
              sourcePageIds: ['source-2'],
              signals: ['semantic', 'lexical', 'exact-title'],
              lexicalScore: 2,
            },
            {
              chunk: chunk(
                'chunk-lexical',
                'kp-lexical',
                [0.1, 0.9],
                'deployment checklist',
              ),
              page: page('kp-lexical'),
              sourcePageIds: ['source-3'],
              signals: ['lexical'],
              lexicalScore: 3,
            },
          ],
          limit: 3,
          rrfK: 60,
        })
        .map((candidate) => candidate.chunk.id),
    ).toEqual(['chunk-combined', 'chunk-lexical', 'chunk-semantic']);
  });
});

function page(id: string, title = `Title ${id}`) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    compileScope: 'space',
    title,
    slug: id,
    pageType: null,
    body: `Body ${id}`,
    summary: null,
    compiledAt: new Date('2026-06-16T00:00:00.000Z'),
    compilerVersion: 'compiler@1',
    compilerRunId: 'run-1',
    compileTaskId: 'task-1',
    staleAt: null,
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
    updatedAt: new Date('2026-06-16T00:00:00.000Z'),
  };
}

function chunk(
  id: string,
  knowledgePageId: string,
  embedding: number[] | null,
  text: string,
) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    knowledgePageId,
    claimId: null,
    text,
    contentHash: `${id}-hash`,
    embedding,
    compilerRunId: 'run-1',
    compileTaskId: 'task-1',
    staleAt: null,
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
  };
}
