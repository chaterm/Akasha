import { KnowledgeRetrievalRankerService } from './knowledge-retrieval-ranker.service';

describe('KnowledgeRetrievalRankerService', () => {
  it('fuses independently ranked SQL recall lists and merges duplicate signals', () => {
    const ranker = new KnowledgeRetrievalRankerService();
    const shared = {
      chunk: chunk('chunk-shared', 'kp-shared', null, 'deployment guide'),
      page: page('kp-shared', 'deployment'),
      sourcePageIds: ['source-shared'],
      signals: ['semantic' as const],
      signalScore: 0.1,
    };

    const ranked = ranker.fuseRecallLists({
      recallLists: [
        { signal: 'semantic', candidates: [shared] },
        {
          signal: 'lexical',
          candidates: [
            {
              ...shared,
              signals: ['lexical'],
              signalScore: 9,
            },
            {
              chunk: chunk('chunk-lexical', 'kp-lexical', null, 'deployment'),
              page: page('kp-lexical'),
              sourcePageIds: ['source-lexical'],
              signals: ['lexical'],
              signalScore: 8,
            },
          ],
        },
        {
          signal: 'exact-title',
          candidates: [{ ...shared, signals: ['exact-title'], signalScore: 1 }],
        },
      ],
      limit: 2,
      rrfK: 60,
    });

    expect(ranked.map((candidate) => candidate.chunk.id)).toEqual([
      'chunk-shared',
      'chunk-lexical',
    ]);
    expect(ranked[0].rankReasons).toEqual([
      'exact-title',
      'semantic',
      'lexical',
    ]);
    expect(ranked[0].signals).toEqual(['semantic', 'lexical', 'exact-title']);
  });

  it('keeps rank reasons to matching methods; the graph path is carried by origin instead', () => {
    const ranker = new KnowledgeRetrievalRankerService();

    const ranked = ranker.fuseRecallLists({
      recallLists: [
        {
          signal: 'semantic',
          candidates: [
            {
              chunk: chunk('chunk-graph', 'kp-graph', null, 'deployment guide'),
              page: page('kp-graph', 'deployment'),
              sourcePageIds: ['source-graph'],
              signals: ['semantic', 'graph'],
              signalScore: 0.1,
            },
          ],
        },
      ],
      limit: 2,
    });

    expect(ranked[0].rankReasons).toEqual(['semantic']);
  });

  it('applies weights per recall list so graph channels can be discounted independently', () => {
    const ranker = new KnowledgeRetrievalRankerService();
    const direct = {
      chunk: chunk('chunk-direct', 'kp-direct', null, 'direct result'),
      page: page('kp-direct'),
      sourcePageIds: ['source-direct'],
      signals: ['lexical' as const],
      signalScore: 1,
      lexicalScore: 1,
    };
    const graph = {
      chunk: chunk('chunk-graph', 'kp-graph', null, 'graph result'),
      page: page('kp-graph'),
      sourcePageIds: ['source-graph'],
      signals: ['lexical' as const, 'graph' as const],
      signalScore: 1,
      lexicalScore: 1,
    };

    const ranked = ranker.fuseRecallLists({
      recallLists: [
        { signal: 'lexical', candidates: [direct], weight: 0.8 },
        { signal: 'lexical', candidates: [graph], weight: 0.15 },
      ],
      limit: 2,
    });

    expect(ranked.map((candidate) => candidate.chunk.id)).toEqual([
      'chunk-direct',
      'chunk-graph',
    ]);
  });

  it('keeps a graph candidate subject to the same relevance gate as a direct hit', () => {
    const ranker = new KnowledgeRetrievalRankerService();
    const graphCandidate = {
      chunk: chunk('chunk-graph', 'kp-graph', null, 'unrelated cafeteria menu'),
      page: page('kp-graph', 'cafeteria'),
      sourcePageIds: ['source-graph'],
      signals: ['semantic' as const, 'graph' as const],
      signalScore: 0.9,
    };
    const [ranked] = ranker.fuseRecallLists({
      recallLists: [{ signal: 'semantic', candidates: [graphCandidate] }],
      limit: 1,
    });

    expect(
      ranker.isCandidateRelevant({
        candidate: ranked,
        maxCosineDistance: 0.2,
      }),
    ).toBe(false);
  });

  it('rejects a semantic-only candidate whose distance exceeds the default threshold', () => {
    const ranker = new KnowledgeRetrievalRankerService();
    const ranked = ranker.fuseRecallLists({
      recallLists: [
        {
          signal: 'semantic',
          candidates: [
            {
              chunk: chunk(
                'chunk-unrelated',
                'kp-unrelated',
                [0, 1],
                'Database backup retention settings',
              ),
              page: page('kp-unrelated', 'Backup operations'),
              sourcePageIds: ['source-unrelated'],
              signals: ['semantic'],
              signalScore: 0.91,
            },
          ],
        },
      ],
      limit: 10,
    });

    expect('isCandidateRelevant' in ranker).toBe(true);
    if (!('isCandidateRelevant' in ranker)) return;
    expect(
      (
        ranker as KnowledgeRetrievalRankerService & {
          isCandidateRelevant(input: unknown): boolean;
        }
      ).isCandidateRelevant({
        candidate: ranked[0],
      }),
    ).toBe(false);
  });

  it('keeps positive lexical candidates for the answer model to assess', () => {
    const ranker = new KnowledgeRetrievalRankerService();
    const ranked = ranker.fuseRecallLists({
      recallLists: [
        {
          signal: 'lexical',
          candidates: [
            {
              chunk: chunk(
                'chunk-lexical',
                'kp-lexical',
                null,
                'Database backup retention settings',
              ),
              page: page('kp-lexical', 'Backup operations'),
              sourcePageIds: ['source-lexical'],
              signals: ['lexical'],
              signalScore: 0.01,
            },
          ],
        },
      ],
      limit: 10,
    });

    expect(
      ranker.isCandidateRelevant({
        candidate: ranked[0],
      }),
    ).toBe(true);
  });

  it('uses a caller-provided semantic cosine distance threshold', () => {
    const ranker = new KnowledgeRetrievalRankerService();
    const ranked = ranker.fuseRecallLists({
      recallLists: [
        {
          signal: 'semantic',
          candidates: [
            {
              chunk: chunk(
                'chunk-unrelated',
                'kp-unrelated',
                [0, 1],
                'Database backup retention settings',
              ),
              page: page('kp-unrelated', 'Backup operations'),
              sourcePageIds: ['source-unrelated'],
              signals: ['semantic'],
              signalScore: 0.91,
            },
          ],
        },
      ],
      limit: 10,
    });

    expect(
      ranker.isCandidateRelevant({
        candidate: ranked[0],
        maxCosineDistance: 1,
      }),
    ).toBe(true);
  });

  it('does not let incidental query/text term overlap rescue a semantically distant chunk', () => {
    const ranker = new KnowledgeRetrievalRankerService();
    // The query shares the term "云桌面" with the chunk text, but the chunk is
    // semantically unrelated (distance 0.9). Overlap must not override the gate.
    const ranked = ranker.fuseRecallLists({
      recallLists: [
        {
          signal: 'semantic',
          candidates: [
            {
              chunk: chunk(
                'chunk-overlap',
                'kp-overlap',
                [0, 1],
                '云桌面支持公共账号登录并多人共享使用',
              ),
              page: page('kp-overlap', '云桌面公共账号支持'),
              sourcePageIds: ['source-overlap'],
              signals: ['semantic'],
              signalScore: 0.9,
            },
          ],
        },
      ],
      limit: 10,
    });

    expect(
      ranker.isCandidateRelevant({
        candidate: ranked[0],
        maxCosineDistance: 0.2,
      }),
    ).toBe(false);
  });
});

function page(id: string, title = `Title ${id}`) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    compileScope: 'page',
    canonicalKey: id,
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
    generationMode: 'legacy',
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
    text,
    contentHash: `${id}-hash`,
    embedding: embedding ? JSON.stringify(embedding) : null,
    embeddingProfile: embedding ? 'a'.repeat(64) : null,
    embeddingModel: embedding ? 'test-embedding' : null,
    embeddingDimensions: embedding?.length ?? null,
    searchTsv: null,
    compilerRunId: 'run-1',
    compileTaskId: 'task-1',
    staleAt: null,
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
  };
}
