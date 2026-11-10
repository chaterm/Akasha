import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeArtifactContributionRepo } from '@akasha/db/repos/llm-wiki/knowledge-artifact-contribution.repo';
import { GroupUserRepo } from '@akasha/db/repos/group/group-user.repo';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { UserRole } from '../../../common/helpers/types/permission';
import { SpaceAuthorizationService } from '../../../core/space/services/space-authorization.service';
import {
  ConfiguredKnowledgeEmbeddingProvider,
  KnowledgeEmbeddingProvider,
} from './knowledge-embedding-provider.service';
import { KnowledgeRetrievalRankerService } from './knowledge-retrieval-ranker.service';
import { KnowledgeSourceAuthorizationService } from './knowledge-source-authorization.service';
import { KnowledgeAuthorizationCache } from './knowledge-source-authorization.cache';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';

describe('KnowledgeRetrievalService', () => {
  it('fails closed without touching any dependency when the cache scope mismatches', async () => {
    const userRepo = { findById: jest.fn() };
    const spaceAuthorization = { filterReadableSpaceIds: jest.fn() };
    const embeddingProvider = { embedQuery: jest.fn() };
    const groupUserRepo = { getUserGroupIds: jest.fn() };
    const capsuleRepo = {
      findDenseChunkCandidates: jest.fn(),
      findLexicalChunkCandidates: jest.fn(),
      findExactTitleChunkCandidates: jest.fn(),
    };
    const service = createService({
      userRepo,
      spaceAuthorization,
      embeddingProvider,
      groupUserRepo,
      capsuleRepo,
    });
    // Cache bound to a different user than the retrieval request.
    const mismatchedCache = new KnowledgeAuthorizationCache({
      workspaceId: 'workspace-1',
      userId: 'other-user',
    });

    const result = await service.retrieve({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'anything',
      spaceIds: ['space-1'],
      authCache: mismatchedCache,
    });

    expect(result.chunks).toEqual([]);
    expect(result.scope).toEqual({
      requestedSpaceIds: ['space-1'],
      effectiveSpaceIds: [],
    });
    expect(userRepo.findById).not.toHaveBeenCalled();
    expect(spaceAuthorization.filterReadableSpaceIds).not.toHaveBeenCalled();
    expect(embeddingProvider.embedQuery).not.toHaveBeenCalled();
    expect(groupUserRepo.getUserGroupIds).not.toHaveBeenCalled();
    expect(capsuleRepo.findDenseChunkCandidates).not.toHaveBeenCalled();
    expect(capsuleRepo.findLexicalChunkCandidates).not.toHaveBeenCalled();
    expect(capsuleRepo.findExactTitleChunkCandidates).not.toHaveBeenCalled();
  });
  it('passes an upstream cancellation signal to query embedding', async () => {
    const abortController = new AbortController();
    const embeddingProvider = {
      embedQuery: jest.fn().mockResolvedValue(null),
    };
    const service = createService({ embeddingProvider });

    await service.retrieve({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'bounded query',
      spaceIds: ['space-1'],
      abortSignal: abortController.signal,
    });

    expect(embeddingProvider.embedQuery).toHaveBeenCalledWith('bounded query', {
      abortSignal: abortController.signal,
    });
  });

  it('withholds merged concept metadata from a reader of only some concept sources', async () => {
    const capsuleRepo = {
      findDenseChunkCandidates: jest
        .fn()
        .mockResolvedValue([
          chunkCandidate(
            'chunk-from-a',
            'kp-concept',
            ['source-a'],
            ['semantic'],
            [0.95, 0.05],
            'Fact from source A',
          ),
        ]),
      findChunkSourcePageIdsByChunkIds: jest
        .fn()
        .mockResolvedValue([
          { chunkId: 'chunk-from-a', sourcePageIds: ['source-a'] },
        ]),
      findPageSourcePageIdsByPageIds: jest
        .fn()
        .mockResolvedValue(new Map([['kp-concept', ['source-a', 'source-b']]])),
    };
    const contributionRepo = {
      findContributionTitles: jest
        .fn()
        .mockResolvedValue([
          {
            artifactId: 'kp-concept',
            sourcePageId: 'source-a',
            title: 'A title',
          },
        ]),
    };
    const service = createService({
      capsuleRepo,
      contributionRepo,
      sourceAuthorization: {
        filterReadableSources: jest
          .fn()
          .mockImplementation(async ({ sourcePageIds }) =>
            sourcePageIds.filter((id: string) => id === 'source-a'),
          ),
      },
    });

    const result = await service.retrieve({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'fact',
      spaceIds: ['space-1'],
    });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].chunk.id).toBe('chunk-from-a');
    expect(result.chunks[0].page).toMatchObject({
      id: 'kp-concept',
      title: 'A title',
      canonicalKey: null,
      summary: null,
      body: '',
    });
    expect(contributionRepo.findContributionTitles).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      pairs: [{ artifactId: 'kp-concept', sourcePageId: 'source-a' }],
    });
  });

  it('keeps merged concept metadata for a reader of every concept source', async () => {
    const capsuleRepo = {
      findDenseChunkCandidates: jest
        .fn()
        .mockResolvedValue([
          chunkCandidate(
            'chunk-from-a',
            'kp-concept',
            ['source-a'],
            ['semantic'],
            [0.95, 0.05],
            'Fact from source A',
          ),
        ]),
      findChunkSourcePageIdsByChunkIds: jest
        .fn()
        .mockResolvedValue([
          { chunkId: 'chunk-from-a', sourcePageIds: ['source-a'] },
        ]),
      findPageSourcePageIdsByPageIds: jest
        .fn()
        .mockResolvedValue(new Map([['kp-concept', ['source-a', 'source-b']]])),
    };
    const service = createService({
      capsuleRepo,
      contributionRepo: { findContributionTitles: jest.fn() },
      sourceAuthorization: {
        filterReadableSources: jest
          .fn()
          .mockImplementation(async ({ sourcePageIds }) => sourcePageIds),
      },
    });

    const result = await service.retrieve({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'fact',
      spaceIds: ['space-1'],
    });

    expect(result.chunks[0].page).toMatchObject({
      title: 'Title kp-concept',
      body: 'Body kp-concept',
    });
  });

  it('pushes principals into bounded recall without enumerating sources and runs one final authorization pass', async () => {
    const capsuleRepo = {
      findDenseChunkCandidates: jest
        .fn()
        .mockResolvedValue([
          chunkCandidate(
            'chunk-visible',
            'kp-visible',
            ['source-visible'],
            ['semantic'],
            [0.95, 0.05],
            'AkashaQwenSmokeTest retrieval',
          ),
        ]),
      findLexicalChunkCandidates: jest
        .fn()
        .mockResolvedValue([
          chunkCandidate(
            'chunk-group',
            'kp-group',
            ['source-group'],
            ['lexical'],
            [0.8, 0.2],
            'AkashaQwenSmokeTest group notes',
          ),
        ]),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
      findChunkSourcePageIdsByChunkIds: jest.fn().mockResolvedValue([
        { chunkId: 'chunk-visible', sourcePageIds: ['source-visible'] },
        { chunkId: 'chunk-group', sourcePageIds: ['source-group'] },
      ]),
    };
    const sourceAuthorization = {
      filterReadableSources: jest.fn().mockResolvedValue(['source-visible']),
    };
    const embeddingProvider = {
      embedQuery: jest.fn().mockResolvedValue(queryEmbedding()),
    };
    const service = createService({
      capsuleRepo,
      sourceAuthorization,
      embeddingProvider,
      groupUserRepo: {
        getUserGroupIds: jest.fn().mockResolvedValue(['group-1']),
      },
    });

    const result = await service.retrieve({
      graphExpansionMode: 'window_recall',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'AkashaQwenSmokeTest 是什么？',
      spaceIds: ['space-1', 'space-2'],
    });
    expect(result).toMatchObject({
      mode: 'high_completeness',
      chunks: [
        {
          chunk: chunk(
            'chunk-visible',
            'kp-visible',
            [0.95, 0.05],
            'AkashaQwenSmokeTest retrieval',
          ),
          page: candidate('kp-visible', 'space-1'),
          sourcePageIds: ['source-visible'],
          rankReasons: ['semantic'],
          origin: 'direct',
        },
      ],
      capsules: [],
      directHitChunkIds: ['chunk-visible'],
      completenessNotice:
        'Some knowledge may be unavailable because access is permission-scoped.',
      scope: {
        requestedSpaceIds: ['space-1', 'space-2'],
        effectiveSpaceIds: ['space-1'],
      },
      diagnostics: {
        queryEmbeddingAvailable: true,
        candidateSourceCount: 2,
        policyCandidateSourceCount: 2,
        fallbackCandidateSourceCount: 0,
        finalAuthorizedSourceCount: 1,
        accessPolicyFallbackUsed: false,
        candidateChunkCount: 2,
        denseCandidateCount: 1,
        lexicalCandidateCount: 1,
        titleCandidateCount: 0,
        evidenceCandidateCount: 2,
        memoryCandidateCount: 2,
        rankedCandidateCount: 2,
        authorizedChunkCount: 1,
        filteredChunkCount: 1,
        ...noGraphDiagnostics(),
        graph: { ...noGraphDiagnostics().graph, expandedSeedCount: 1 },
      },
    });
    expect(result.retrievalObservation).toMatchObject({
      attempted: true,
      topK: 20,
      threshold: 0.45,
      candidates: expect.arrayContaining([
        expect.objectContaining({
          chunkId: 'chunk-visible',
          stage: 'direct',
          scoreType: 'semantic_distance',
        }),
      ]),
    });

    expect(embeddingProvider.embedQuery).toHaveBeenCalledWith(
      'AkashaQwenSmokeTest 是什么？',
    );
    expect(capsuleRepo.findDenseChunkCandidates).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      principals: [
        { principalType: 'user', principalId: 'user-1' },
        { principalType: 'group', principalId: 'group-1' },
      ],
      embedding: queryEmbedding(),
      retrievalChannel: 'evidence',
      authorizationMode: 'policy',
      limit: 200,
    });
    expect(capsuleRepo.findChunkSourcePageIdsByChunkIds).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      chunkIds: ['chunk-visible', 'chunk-group'],
    });
    expect(sourceAuthorization.filterReadableSources).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        sourcePageIds: ['source-visible', 'source-group'],
      }),
    );
    expect(sourceAuthorization.filterReadableSources).toHaveBeenCalledTimes(1);
  });

  it('does not query candidates when the user has no readable spaces', async () => {
    const capsuleRepo = {
      findDenseChunkCandidates: jest.fn(),
      findLexicalChunkCandidates: jest.fn(),
      findExactTitleChunkCandidates: jest.fn(),
    };
    const service = createService({
      capsuleRepo,
      spaceAuthorization: {
        filterReadableSpaceIds: jest.fn().mockResolvedValue([]),
      },
    });

    await expect(
      service.retrieve({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        query: 'kafka',
        spaceIds: ['space-1'],
      }),
    ).resolves.toMatchObject({
      mode: 'high_completeness',
      chunks: [],
      capsules: [],
      directHitChunkIds: [],
      completenessNotice:
        'Some knowledge may be unavailable because access is permission-scoped.',
      scope: {
        requestedSpaceIds: ['space-1'],
        effectiveSpaceIds: [],
      },
      diagnostics: {
        queryEmbeddingAvailable: false,
        candidateSourceCount: 0,
        policyCandidateSourceCount: 0,
        fallbackCandidateSourceCount: 0,
        finalAuthorizedSourceCount: 0,
        accessPolicyFallbackUsed: false,
        candidateChunkCount: 0,
        denseCandidateCount: 0,
        lexicalCandidateCount: 0,
        titleCandidateCount: 0,
        evidenceCandidateCount: 0,
        memoryCandidateCount: 0,
        rankedCandidateCount: 0,
        authorizedChunkCount: 0,
        filteredChunkCount: 0,
        ...noGraphDiagnostics(),
      },
    });

    expect(capsuleRepo.findDenseChunkCandidates).not.toHaveBeenCalled();
  });

  it('uses independent bounded database recall limits', async () => {
    const capsuleRepo = {
      findDenseChunkCandidates: jest
        .fn()
        .mockResolvedValue(
          Array.from({ length: 10 }, (_, index) =>
            chunkCandidate(
              `chunk-${index}`,
              `kp-${index}`,
              ['source-1'],
              ['semantic'],
              [1, 0],
              `Chunk ${index}`,
            ),
          ),
        ),
      findLexicalChunkCandidates: jest.fn().mockResolvedValue([]),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
      findChunkSourcePageIdsByChunkIds: jest
        .fn()
        .mockImplementation(({ chunkIds }) =>
          Promise.resolve(
            chunkIds.map((chunkId: string) => ({
              chunkId,
              sourcePageIds: ['source-1'],
            })),
          ),
        ),
    };
    const service = createService({
      capsuleRepo,
      embeddingProvider: {
        embedQuery: jest.fn().mockResolvedValue(queryEmbedding()),
      },
    });

    const result = await service.retrieve({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'kafka',
      spaceIds: ['space-1'],
      candidateLimit: 5,
    });

    expect(capsuleRepo.findDenseChunkCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
    expect(capsuleRepo.findChunkSourcePageIdsByChunkIds).toHaveBeenCalledTimes(
      1,
    );
    expect(result.chunks).toHaveLength(5);
  });

  it('falls back to lexical retrieval when query embedding is unavailable', async () => {
    const capsuleRepo = {
      findDenseChunkCandidates: jest.fn(),
      findLexicalChunkCandidates: jest
        .fn()
        .mockResolvedValue([
          chunkCandidate(
            'chunk-lexical',
            'kp-lexical',
            ['source-lexical'],
            ['lexical'],
            null,
            'AkashaQwenSmokeTest lexical fallback',
          ),
        ]),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
      findChunkSourcePageIdsByChunkIds: jest
        .fn()
        .mockResolvedValue([
          { chunkId: 'chunk-lexical', sourcePageIds: ['source-lexical'] },
        ]),
    };
    const service = createService({
      capsuleRepo,
      embeddingProvider: { embedQuery: jest.fn().mockResolvedValue(null) },
      sourceAuthorization: {
        filterReadableSources: jest.fn().mockResolvedValue(['source-lexical']),
      },
    });

    await expect(
      service.retrieve({
        graphExpansionMode: 'window_recall',
        workspaceId: 'workspace-1',
        userId: 'user-1',
        query: 'AkashaQwenSmokeTest 是什么？',
        spaceIds: ['space-1'],
      }),
    ).resolves.toMatchObject({
      mode: 'high_completeness',
      chunks: [
        {
          chunk: chunk(
            'chunk-lexical',
            'kp-lexical',
            null,
            'AkashaQwenSmokeTest lexical fallback',
          ),
          page: candidate('kp-lexical', 'space-1'),
          sourcePageIds: ['source-lexical'],
          rankReasons: ['lexical'],
          origin: 'direct',
        },
      ],
      capsules: [],
      directHitChunkIds: ['chunk-lexical'],
      completenessNotice:
        'Some knowledge may be unavailable because access is permission-scoped.',
      scope: {
        requestedSpaceIds: ['space-1'],
        effectiveSpaceIds: ['space-1'],
      },
      diagnostics: {
        queryEmbeddingAvailable: false,
        candidateSourceCount: 1,
        policyCandidateSourceCount: 1,
        fallbackCandidateSourceCount: 0,
        finalAuthorizedSourceCount: 1,
        accessPolicyFallbackUsed: false,
        candidateChunkCount: 1,
        denseCandidateCount: 0,
        lexicalCandidateCount: 1,
        titleCandidateCount: 0,
        evidenceCandidateCount: 1,
        memoryCandidateCount: 1,
        rankedCandidateCount: 1,
        authorizedChunkCount: 1,
        filteredChunkCount: 0,
        ...noGraphDiagnostics(),
        graph: { ...noGraphDiagnostics().graph, expandedSeedCount: 1 },
      },
    });

    expect(capsuleRepo.findDenseChunkCandidates).not.toHaveBeenCalled();
    expect(capsuleRepo.findLexicalChunkCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'AkashaQwenSmokeTest 是什么？',
      }),
    );
  });

  it('uses a bounded final-authorization fallback when policy recall returns no candidates', async () => {
    const fallbackCandidate = chunkCandidate(
      'chunk-fallback',
      'kp-fallback',
      ['source-fallback'],
      ['semantic'],
      [1, 0],
      'Fallback candidate',
    );
    const capsuleRepo = {
      findDenseChunkCandidates: jest
        .fn()
        .mockImplementation(({ authorizationMode }) =>
          Promise.resolve(
            authorizationMode === 'final-authorization-fallback'
              ? [fallbackCandidate]
              : [],
          ),
        ),
      findLexicalChunkCandidates: jest.fn().mockResolvedValue([]),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
      findChunkSourcePageIdsByChunkIds: jest.fn().mockResolvedValue([
        {
          chunkId: 'chunk-fallback',
          sourcePageIds: ['source-fallback'],
        },
      ]),
    };
    const service = createService({
      capsuleRepo,
      sourceAuthorization: {
        filterReadableSources: jest.fn().mockResolvedValue(['source-fallback']),
      },
    });

    const result = await service.retrieve({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'fallback',
      spaceIds: ['space-1'],
    });

    expect(result.mode).toBe('high_completeness_fallback');
    expect(result.chunks).toEqual([
      expect.objectContaining({
        sourcePageIds: ['source-fallback'],
        rankReasons: ['semantic'],
        authorizationMode: 'final-authorization-fallback',
      }),
    ]);
    expect(result.diagnostics).toEqual(
      expect.objectContaining({
        candidateSourceCount: 1,
        policyCandidateSourceCount: 0,
        fallbackCandidateSourceCount: 1,
        finalAuthorizedSourceCount: 1,
        accessPolicyFallbackUsed: true,
      }),
    );
    expect(capsuleRepo.findDenseChunkCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationMode: 'final-authorization-fallback',
        limit: 200,
      }),
    );
  });

  it('drops a weak semantic-only candidate before authorization and graph expansion', async () => {
    const weakCandidate = {
      ...chunkCandidate(
        'chunk-unrelated',
        'kp-unrelated',
        ['source-unrelated'],
        ['semantic'],
        [0, 1],
        'Database backup retention settings',
      ),
      signalScore: 0.91,
      page: {
        ...candidate('kp-unrelated', 'space-1'),
        title: 'Backup operations',
      },
    };
    const capsuleRepo = {
      findDenseChunkCandidates: jest.fn().mockResolvedValue([weakCandidate]),
      findLexicalChunkCandidates: jest.fn().mockResolvedValue([]),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
      findChunkSourcePageIdsByChunkIds: jest.fn().mockResolvedValue([
        {
          chunkId: 'chunk-unrelated',
          sourcePageIds: ['source-unrelated'],
        },
      ]),
      findGraphTraversalEdges: jest.fn(),
    };
    const service = createService({ capsuleRepo });

    const result = await service.retrieve({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'employee vacation policy',
      spaceIds: ['space-1'],
    });

    expect(result.chunks).toEqual([]);
    expect(capsuleRepo.findChunkSourcePageIdsByChunkIds).not.toHaveBeenCalled();
    expect(capsuleRepo.findGraphTraversalEdges).not.toHaveBeenCalled();
  });

  it('expands authorized direct hits through one readable graph hop', async () => {
    const direct = chunkCandidate(
      'chunk-seed',
      'kp-seed',
      ['source-seed'],
      ['lexical'],
      null,
      'Seed result',
    );
    const firstNeighbor = chunkCandidate(
      'chunk-neighbor-1',
      'kp-neighbor-1',
      ['source-neighbor-1'],
      ['lexical'],
      null,
      'First graph neighbor seed',
    );
    const secondNeighbor = chunkCandidate(
      'chunk-neighbor-2',
      'kp-neighbor-2',
      ['source-neighbor-2'],
      ['lexical'],
      null,
      'Second graph neighbor seed',
    );
    const capsuleRepo = {
      findDenseChunkCandidates: jest.fn().mockResolvedValue([]),
      findLexicalChunkCandidates: jest
        .fn()
        .mockImplementation(({ knowledgePageIds }) =>
          Promise.resolve(
            knowledgePageIds ? [firstNeighbor, secondNeighbor] : [direct],
          ),
        ),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
      findChunkSourcePageIdsByChunkIds: jest.fn().mockResolvedValue([
        { chunkId: 'chunk-seed', sourcePageIds: ['source-seed'] },
        { chunkId: 'chunk-neighbor-1', sourcePageIds: ['source-neighbor-1'] },
        { chunkId: 'chunk-neighbor-2', sourcePageIds: ['source-neighbor-2'] },
      ]),
      findGraphFrontierSourceIds: jest
        .fn()
        .mockResolvedValue(['source-edge-1', 'source-edge-2']),
      findGraphTraversalEdges: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'link-1',
            fromKnowledgePageId: 'kp-seed',
            toKnowledgePageId: 'kp-neighbor-1',
            type: 'link',
            weight: 0.7,
            sourcePageIds: ['source-edge-1'],
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'edge-2',
            fromKnowledgePageId: 'kp-neighbor-1',
            toKnowledgePageId: 'kp-neighbor-2',
            type: 'link',
            weight: 0.7,
            sourcePageIds: ['source-edge-2'],
          },
        ]),
    };
    const sourceAuthorization = {
      filterReadableSources: jest
        .fn()
        .mockImplementation(({ sourcePageIds }) =>
          Promise.resolve(sourcePageIds),
        ),
    };
    const service = createService({ capsuleRepo, sourceAuthorization });

    const result = await service.retrieve({
      graphExpansionMode: 'window_recall',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'seed',
      spaceIds: ['space-1'],
      labelNames: ['项目计划', 'kafka'],
      candidateLimit: 4,
    });

    expect(result.chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chunk: expect.objectContaining({ id: 'chunk-seed' }),
          origin: 'direct',
        }),
        expect.objectContaining({
          chunk: expect.objectContaining({ id: 'chunk-neighbor-1' }),
          origin: 'graph',
          rankReasons: ['lexical'],
        }),
      ]),
    );
    expect(result.retrievalObservation.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chunkId: 'chunk-neighbor-1',
          stage: 'graph',
        }),
        expect.objectContaining({
          chunkId: 'chunk-neighbor-2',
          stage: 'graph',
        }),
      ]),
    );
    expect(capsuleRepo.findGraphTraversalEdges).toHaveBeenCalledTimes(1);
    expect(capsuleRepo.findLexicalChunkCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgePageIds: ['kp-neighbor-1'],
        principals: [{ principalType: 'user', principalId: 'user-1' }],
        labelNames: ['项目计划', 'kafka'],
      }),
    );
  });

  it('does not traverse a graph edge whose complete lineage is unreadable', async () => {
    const direct = chunkCandidate(
      'chunk-seed',
      'kp-seed',
      ['source-seed'],
      ['lexical'],
      null,
      'Seed result',
    );
    const capsuleRepo = {
      findDenseChunkCandidates: jest.fn().mockResolvedValue([]),
      findLexicalChunkCandidates: jest.fn().mockResolvedValue([direct]),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
      findChunkSourcePageIdsByChunkIds: jest
        .fn()
        .mockResolvedValue([
          { chunkId: 'chunk-seed', sourcePageIds: ['source-seed'] },
        ]),
      findGraphFrontierSourceIds: jest
        .fn()
        .mockResolvedValue(['source-seed', 'source-private']),
      findGraphTraversalEdges: jest.fn().mockResolvedValue([]),
    };
    const sourceAuthorization = {
      filterReadableSources: jest
        .fn()
        .mockImplementation(({ sourcePageIds }) =>
          Promise.resolve(
            sourcePageIds.filter(
              (sourcePageId: string) => sourcePageId !== 'source-private',
            ),
          ),
        ),
    };
    const service = createService({ capsuleRepo, sourceAuthorization });

    const result = await service.retrieve({
      graphExpansionMode: 'window_recall',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'seed',
      spaceIds: ['space-1'],
      candidateLimit: 4,
    });

    expect(result.chunks).toHaveLength(1);
    expect(capsuleRepo.findGraphTraversalEdges).toHaveBeenCalledWith(
      expect.objectContaining({ readableSourcePageIds: ['source-seed'] }),
    );
    expect(capsuleRepo.findLexicalChunkCandidates).not.toHaveBeenCalledWith(
      expect.objectContaining({ knowledgePageIds: expect.anything() }),
    );
  });

  it('gates out an irrelevant graph neighbor instead of admitting it on a quota', async () => {
    const direct = chunkCandidate(
      'chunk-seed',
      'kp-seed',
      ['source-seed'],
      ['lexical'],
      null,
      'vacation policy seed',
    );
    const irrelevant = {
      ...chunkCandidate(
        'chunk-irrelevant',
        'kp-neighbor',
        ['source-neighbor'],
        ['semantic'],
        [0, 1],
        'unrelated cafeteria menu',
      ),
      signalScore: 0.99,
    };
    const capsuleRepo = {
      findDenseChunkCandidates: jest
        .fn()
        .mockImplementation(({ knowledgePageIds }) =>
          Promise.resolve(knowledgePageIds ? [irrelevant] : []),
        ),
      findLexicalChunkCandidates: jest
        .fn()
        .mockImplementation(({ knowledgePageIds }) =>
          Promise.resolve(knowledgePageIds ? [] : [direct]),
        ),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
      findChunkSourcePageIdsByChunkIds: jest.fn().mockResolvedValue([
        { chunkId: 'chunk-seed', sourcePageIds: ['source-seed'] },
        { chunkId: 'chunk-irrelevant', sourcePageIds: ['source-neighbor'] },
      ]),
      findGraphFrontierSourceIds: jest.fn().mockResolvedValue(['source-edge']),
      findGraphTraversalEdges: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'edge-1',
            fromKnowledgePageId: 'kp-seed',
            toKnowledgePageId: 'kp-neighbor',
            type: 'link',
            weight: 0.7,
            sourcePageIds: ['source-edge'],
          },
        ])
        .mockResolvedValue([]),
    };
    const service = createService({
      capsuleRepo,
      sourceAuthorization: {
        filterReadableSources: jest
          .fn()
          .mockImplementation(({ sourcePageIds }) =>
            Promise.resolve(sourcePageIds),
          ),
      },
    });

    const result = await service.retrieve({
      graphExpansionMode: 'window_recall',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'vacation policy',
      spaceIds: ['space-1'],
      candidateLimit: 4,
      maxCosineDistance: 0.2,
    });

    expect(result.chunks.map(({ chunk }) => chunk.id)).toEqual(['chunk-seed']);
    expect(result.diagnostics.graph.candidateCount).toBe(1);
    expect(result.diagnostics.graph.gatedOutCount).toBe(1);
    expect(result.diagnostics.graph.selectedCount).toBe(0);
  });

  it('ranks a strongly relevant graph neighbor above a weak direct hit', async () => {
    const weakDirect = {
      ...chunkCandidate(
        'chunk-weak-direct',
        'kp-seed',
        ['source-seed'],
        ['lexical'],
        null,
        'passing mention of vacation',
      ),
      signalScore: 0.01,
      lexicalScore: 0.01,
    };
    const strongGraph = {
      ...chunkCandidate(
        'chunk-strong-graph',
        'kp-neighbor',
        ['source-neighbor'],
        ['semantic'],
        [1, 0],
        'vacation policy: accrual, carryover and payout rules',
      ),
      signalScore: 0.02,
    };
    const capsuleRepo = {
      findDenseChunkCandidates: jest
        .fn()
        .mockImplementation(({ knowledgePageIds }) =>
          Promise.resolve(knowledgePageIds ? [strongGraph] : []),
        ),
      findLexicalChunkCandidates: jest
        .fn()
        .mockImplementation(({ knowledgePageIds, retrievalChannel }) =>
          Promise.resolve(
            !knowledgePageIds && retrievalChannel === 'evidence'
              ? [weakDirect]
              : [],
          ),
        ),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
      findChunkSourcePageIdsByChunkIds: jest.fn().mockResolvedValue([
        { chunkId: 'chunk-weak-direct', sourcePageIds: ['source-seed'] },
        { chunkId: 'chunk-strong-graph', sourcePageIds: ['source-neighbor'] },
      ]),
      findGraphFrontierSourceIds: jest.fn().mockResolvedValue(['source-edge']),
      findGraphTraversalEdges: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'edge-1',
            fromKnowledgePageId: 'kp-seed',
            toKnowledgePageId: 'kp-neighbor',
            type: 'link',
            weight: 0.7,
            sourcePageIds: ['source-edge'],
          },
        ])
        .mockResolvedValue([]),
    };
    const service = createService({
      capsuleRepo,
      sourceAuthorization: {
        filterReadableSources: jest
          .fn()
          .mockImplementation(({ sourcePageIds }) =>
            Promise.resolve(sourcePageIds),
          ),
      },
    });

    const result = await service.retrieve({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'vacation policy',
      spaceIds: ['space-1'],
      candidateLimit: 4,
      graphExpansionMode: 'window_recall',
    });

    expect(result.chunks.map(({ chunk }) => chunk.id)).toEqual([
      'chunk-strong-graph',
      'chunk-weak-direct',
    ]);
    expect(result.chunks[0].origin).toBe('graph');
    expect(result.diagnostics.graph.selectedCount).toBe(1);
  });

  it('keeps graph expansion to one hop', async () => {
    const direct = chunkCandidate(
      'chunk-seed',
      'kp-seed',
      ['source-seed'],
      ['lexical'],
      null,
      'vacation policy seed',
    );
    const oneHop = Array.from({ length: 6 }, (_, index) => `kp-hop1-${index}`);
    const twoHop = Array.from({ length: 6 }, (_, index) => `kp-hop2-${index}`);
    const capsuleRepo = {
      findDenseChunkCandidates: jest.fn().mockResolvedValue([]),
      findLexicalChunkCandidates: jest
        .fn()
        .mockImplementation(({ knowledgePageIds }) =>
          Promise.resolve(knowledgePageIds ? [] : [direct]),
        ),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
      findChunkSourcePageIdsByChunkIds: jest
        .fn()
        .mockResolvedValue([
          { chunkId: 'chunk-seed', sourcePageIds: ['source-seed'] },
        ]),
      findGraphFrontierSourceIds: jest.fn().mockResolvedValue(['source-edge']),
      findGraphTraversalEdges: jest
        .fn()
        .mockResolvedValueOnce(
          oneHop.map((pageId, index) => ({
            id: `edge-hop1-${index}`,
            fromKnowledgePageId: 'kp-seed',
            toKnowledgePageId: pageId,
            type: 'link',
            weight: 0.7,
            sourcePageIds: ['source-edge'],
          })),
        )
        .mockResolvedValueOnce(
          twoHop.map((pageId, index) => ({
            id: `edge-hop2-${index}`,
            fromKnowledgePageId: oneHop[0],
            toKnowledgePageId: pageId,
            type: 'link',
            weight: 0.7,
            sourcePageIds: ['source-edge'],
          })),
        )
        .mockResolvedValue([]),
    };
    const service = createService({
      capsuleRepo,
      sourceAuthorization: {
        filterReadableSources: jest
          .fn()
          .mockImplementation(({ sourcePageIds }) =>
            Promise.resolve(sourcePageIds),
          ),
      },
    });

    await service.retrieve({
      graphExpansionMode: 'window_recall',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'vacation policy',
      spaceIds: ['space-1'],
      candidateLimit: 2,
    });

    const windowCall = capsuleRepo.findLexicalChunkCandidates.mock.calls.find(
      ([args]) => args.knowledgePageIds,
    );
    expect(windowCall).toBeDefined();
    const window = windowCall![0].knowledgePageIds as string[];
    expect(window).toEqual([...oneHop].sort());
    expect(capsuleRepo.findGraphTraversalEdges).toHaveBeenCalledTimes(1);
  });

  it('expands only seeds above the relative weight threshold', async () => {
    const strong = chunkCandidate(
      'chunk-strong',
      'kp-strong',
      ['source-strong'],
      ['exact-title'],
      null,
      'vacation policy',
    );
    const weak = chunkCandidate(
      'chunk-weak',
      'kp-weak',
      ['source-weak'],
      ['lexical'],
      null,
      'vacation',
    );
    const capsuleRepo = {
      findDenseChunkCandidates: jest.fn().mockResolvedValue([]),
      findLexicalChunkCandidates: jest
        .fn()
        .mockImplementation(({ knowledgePageIds }) =>
          Promise.resolve(knowledgePageIds ? [] : [weak]),
        ),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([strong]),
      findChunkSourcePageIdsByChunkIds: jest.fn().mockResolvedValue([
        { chunkId: 'chunk-strong', sourcePageIds: ['source-strong'] },
        { chunkId: 'chunk-weak', sourcePageIds: ['source-weak'] },
      ]),
      findGraphFrontierSourceIds: jest.fn().mockResolvedValue([]),
      findGraphTraversalEdges: jest.fn().mockResolvedValue([]),
    };
    const service = createService({
      capsuleRepo,
      sourceAuthorization: {
        filterReadableSources: jest
          .fn()
          .mockImplementation(({ sourcePageIds }) =>
            Promise.resolve(sourcePageIds),
          ),
      },
    });

    const result = await service.retrieve({
      graphExpansionMode: 'window_recall',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'vacation policy',
      spaceIds: ['space-1'],
      candidateLimit: 4,
    });

    const frontier = capsuleRepo.findGraphFrontierSourceIds.mock.calls[0][0];
    expect(frontier.knowledgePageIds[0]).toBe('kp-strong');
    expect(result.diagnostics.graph.expandedSeedCount).toBeGreaterThan(0);
    expect(result.diagnostics.graph.expandedSeedCount).toBe(2);
  });

  it('tags direct hits with origin=direct and graph hits with origin=graph, and only direct hits enter directHitChunkIds', async () => {
    const direct = chunkCandidate(
      'chunk-seed',
      'kp-seed',
      ['source-seed'],
      ['lexical'],
      null,
      'Seed result',
    );
    const neighbor = chunkCandidate(
      'chunk-neighbor',
      'kp-neighbor',
      ['source-neighbor'],
      ['lexical'],
      null,
      'Graph neighbor seed',
    );
    const capsuleRepo = {
      findDenseChunkCandidates: jest.fn().mockResolvedValue([]),
      findLexicalChunkCandidates: jest
        .fn()
        .mockImplementation(({ knowledgePageIds }) =>
          Promise.resolve(knowledgePageIds ? [neighbor] : [direct]),
        ),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
      findChunkSourcePageIdsByChunkIds: jest.fn().mockResolvedValue([
        { chunkId: 'chunk-seed', sourcePageIds: ['source-seed'] },
        { chunkId: 'chunk-neighbor', sourcePageIds: ['source-neighbor'] },
      ]),
      findGraphFrontierSourceIds: jest.fn().mockResolvedValue(['source-edge']),
      findGraphTraversalEdges: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'edge-1',
            fromKnowledgePageId: 'kp-seed',
            toKnowledgePageId: 'kp-neighbor',
            type: 'link',
            weight: 0.7,
            sourcePageIds: ['source-edge'],
          },
        ])
        .mockResolvedValue([]),
    };
    const sourceAuthorization = {
      filterReadableSources: jest
        .fn()
        .mockImplementation(({ sourcePageIds }) =>
          Promise.resolve(sourcePageIds),
        ),
    };
    const service = createService({ capsuleRepo, sourceAuthorization });

    const result = await service.retrieve({
      graphExpansionMode: 'window_recall',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'seed',
      spaceIds: ['space-1'],
      candidateLimit: 4,
    });

    expect(
      result.chunks.map(({ chunk, origin }) => ({ id: chunk.id, origin })),
    ).toEqual([
      { id: 'chunk-seed', origin: 'direct' },
      { id: 'chunk-neighbor', origin: 'graph' },
    ]);
    // Graph-only chunks never contribute attachments (§7.1 / §1.2).
    expect(result.directHitChunkIds).toEqual(['chunk-seed']);
  });

  it('keeps origin=direct on final-authorization-fallback hits without relying on rankReasons', async () => {
    const fallbackCandidate = chunkCandidate(
      'chunk-fallback',
      'kp-fallback',
      ['source-fallback'],
      ['semantic'],
      [1, 0],
      'Fallback candidate',
    );
    const capsuleRepo = {
      findDenseChunkCandidates: jest
        .fn()
        .mockImplementation(({ authorizationMode }) =>
          Promise.resolve(
            authorizationMode === 'final-authorization-fallback'
              ? [fallbackCandidate]
              : [],
          ),
        ),
      findLexicalChunkCandidates: jest.fn().mockResolvedValue([]),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
      findChunkSourcePageIdsByChunkIds: jest
        .fn()
        .mockResolvedValue([
          { chunkId: 'chunk-fallback', sourcePageIds: ['source-fallback'] },
        ]),
    };
    const service = createService({
      capsuleRepo,
      sourceAuthorization: {
        filterReadableSources: jest.fn().mockResolvedValue(['source-fallback']),
      },
    });

    const result = await service.retrieve({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'fallback',
      spaceIds: ['space-1'],
    });

    expect(result.chunks[0].origin).toBe('direct');
    // 路径和授权都走独立字段，rankReasons 只剩匹配方式。
    expect(result.chunks[0].rankReasons).toEqual(['semantic']);
    expect(result.chunks[0].authorizationMode).toBe(
      'final-authorization-fallback',
    );
    expect(result.directHitChunkIds).toEqual(['chunk-fallback']);
  });

  it('treats a chunk that is both a direct hit and a graph neighbor as direct', async () => {
    const shared = chunkCandidate(
      'chunk-shared',
      'kp-shared',
      ['source-shared'],
      ['lexical'],
      null,
      'Shared result',
    );
    // Graph expansion rediscovers the same chunk id (e.g. reached via a
    // neighbor page); blend must keep the direct copy.
    const graphView = chunkCandidate(
      'chunk-shared',
      'kp-other',
      ['source-other'],
      ['lexical'],
      null,
      'Shared result',
    );
    const capsuleRepo = {
      findDenseChunkCandidates: jest.fn().mockResolvedValue([]),
      findLexicalChunkCandidates: jest
        .fn()
        .mockImplementation(({ knowledgePageIds }) =>
          Promise.resolve(knowledgePageIds ? [graphView] : [shared]),
        ),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
      findChunkSourcePageIdsByChunkIds: jest
        .fn()
        .mockResolvedValue([
          { chunkId: 'chunk-shared', sourcePageIds: ['source-shared'] },
        ]),
      findGraphFrontierSourceIds: jest.fn().mockResolvedValue(['source-other']),
      findGraphTraversalEdges: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'edge-1',
            fromKnowledgePageId: 'kp-shared',
            toKnowledgePageId: 'kp-other',
            type: 'link',
            weight: 0.7,
            sourcePageIds: ['source-other'],
          },
        ])
        .mockResolvedValue([]),
    };
    const sourceAuthorization = {
      filterReadableSources: jest
        .fn()
        .mockImplementation(({ sourcePageIds }) =>
          Promise.resolve(sourcePageIds),
        ),
    };
    const service = createService({ capsuleRepo, sourceAuthorization });

    const result = await service.retrieve({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'shared',
      spaceIds: ['space-1'],
      candidateLimit: 4,
    });

    // The direct copy is ordered first (blend keeps direct priority), so the
    // first occurrence of the shared id carries origin='direct'.
    expect(
      result.chunks.find((c) => c.chunk.id === 'chunk-shared')?.origin,
    ).toBe('direct');
    // Only the direct-origin entry feeds attachment resolution, so the shared
    // id appears exactly once in directHitChunkIds even though graph expansion
    // also surfaced it (§1.2: "既 direct 又 graph 按 direct").
    expect(result.directHitChunkIds).toEqual(['chunk-shared']);
    // The shared chunk must appear exactly once in the blended result: blend
    // dedups on its own, so a duplicate can never occupy two slots (which would
    // otherwise burn a graph slot and drop a real direct hit).
    const sharedOccurrences = result.chunks.filter(
      (c) => c.chunk.id === 'chunk-shared',
    );
    expect(sharedOccurrences).toHaveLength(1);
    // No chunk id is duplicated anywhere in the blended result.
    const chunkIds = result.chunks.map((c) => c.chunk.id);
    expect(new Set(chunkIds).size).toBe(chunkIds.length);
  });

  it('keeps direct origin when graph selects a direct hit below the reserved direct cutoff', async () => {
    const direct = [
      chunkCandidate(
        'chunk-a',
        'kp-a',
        ['source-a'],
        ['lexical'],
        null,
        'Shared query result A',
      ),
      chunkCandidate(
        'chunk-b',
        'kp-b',
        ['source-b'],
        ['lexical'],
        null,
        'Shared query result B',
      ),
      chunkCandidate(
        'chunk-c',
        'kp-c',
        ['source-c'],
        ['lexical'],
        null,
        'Shared query result C',
      ),
      chunkCandidate(
        'chunk-z-shared',
        'kp-shared',
        ['source-shared'],
        ['lexical'],
        null,
        'Shared query result Z',
      ),
    ];
    const graphView = chunkCandidate(
      'chunk-z-shared',
      'kp-neighbor',
      ['source-neighbor'],
      ['lexical'],
      null,
      'Shared query result Z',
    );
    const capsuleRepo = {
      findDenseChunkCandidates: jest.fn().mockResolvedValue([]),
      findLexicalChunkCandidates: jest
        .fn()
        .mockImplementation(({ knowledgePageIds }) =>
          Promise.resolve(knowledgePageIds ? [graphView] : direct),
        ),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
      findChunkSourcePageIdsByChunkIds: jest.fn().mockResolvedValue(
        direct.map((candidate) => ({
          chunkId: candidate.chunk.id,
          sourcePageIds: candidate.sourcePageIds,
        })),
      ),
      findGraphFrontierSourceIds: jest.fn().mockResolvedValue(['source-edge']),
      findGraphTraversalEdges: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'edge-1',
            fromKnowledgePageId: 'kp-a',
            toKnowledgePageId: 'kp-neighbor',
            type: 'link',
            weight: 0.7,
            sourcePageIds: ['source-edge'],
          },
        ])
        .mockResolvedValue([]),
    };
    const service = createService({
      capsuleRepo,
      sourceAuthorization: {
        filterReadableSources: jest
          .fn()
          .mockImplementation(({ sourcePageIds }) =>
            Promise.resolve(sourcePageIds),
          ),
      },
    });

    const result = await service.retrieve({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'shared query',
      spaceIds: ['space-1'],
      candidateLimit: 4,
      graphExpansionMode: 'window_recall',
    });

    expect(
      result.chunks.map(({ chunk, origin }) => ({ id: chunk.id, origin })),
    ).toEqual([
      { id: 'chunk-z-shared', origin: 'direct' },
      { id: 'chunk-a', origin: 'direct' },
      { id: 'chunk-b', origin: 'direct' },
      { id: 'chunk-c', origin: 'direct' },
    ]);
    expect(result.directHitChunkIds).toEqual([
      'chunk-z-shared',
      'chunk-a',
      'chunk-b',
      'chunk-c',
    ]);
    expect(new Set(result.directHitChunkIds).size).toBe(4);
  });

  it('caps graph-only results so graph RRF votes cannot crowd direct hits out of top-k', async () => {
    const direct = Array.from({ length: 4 }, (_, index) =>
      chunkCandidate(
        `chunk-direct-${index}`,
        `kp-direct-${index}`,
        [`source-direct-${index}`],
        index === 0 ? ['exact-title'] : ['lexical'],
        null,
        `vacation policy direct result ${index}`,
      ),
    );
    const graph = Array.from({ length: 4 }, (_, index) =>
      chunkCandidate(
        `chunk-graph-${index}`,
        `kp-graph-${index}`,
        [`source-graph-${index}`],
        ['semantic', 'lexical'],
        [1, 0],
        `vacation policy graph result ${index}`,
      ),
    );
    const allCandidates = [...direct, ...graph];
    const capsuleRepo = {
      findDenseChunkCandidates: jest
        .fn()
        .mockImplementation(({ knowledgePageIds }) =>
          Promise.resolve(knowledgePageIds ? graph : []),
        ),
      findLexicalChunkCandidates: jest
        .fn()
        .mockImplementation(({ knowledgePageIds, retrievalChannel }) => {
          if (knowledgePageIds) return Promise.resolve(graph);
          return Promise.resolve(
            retrievalChannel === 'evidence' ? direct.slice(1) : [],
          );
        }),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([direct[0]]),
      findChunkSourcePageIdsByChunkIds: jest.fn().mockResolvedValue(
        allCandidates.map((candidate) => ({
          chunkId: candidate.chunk.id,
          sourcePageIds: candidate.sourcePageIds,
        })),
      ),
      findGraphFrontierSourceIds: jest.fn().mockResolvedValue(['source-edge']),
      findGraphTraversalEdges: jest
        .fn()
        .mockResolvedValueOnce(
          graph.map((candidate, index) => ({
            id: `edge-${index}`,
            fromKnowledgePageId: 'kp-direct-0',
            toKnowledgePageId: candidate.page.id,
            type: 'link',
            weight: 0.7,
            sourcePageIds: ['source-edge'],
          })),
        )
        .mockResolvedValue([]),
    };
    const service = createService({
      capsuleRepo,
      sourceAuthorization: {
        filterReadableSources: jest
          .fn()
          .mockImplementation(({ sourcePageIds }) =>
            Promise.resolve(sourcePageIds),
          ),
      },
    });

    const result = await service.retrieve({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'vacation policy',
      spaceIds: ['space-1'],
      candidateLimit: 4,
    });

    expect(result.chunks).toHaveLength(4);
    expect(result.chunks[0]).toMatchObject({
      chunk: { id: 'chunk-direct-0' },
      origin: 'direct',
    });
    expect(
      result.chunks.filter((candidate) => candidate.origin === 'graph').length,
    ).toBe(1);
    expect(
      result.chunks.filter((candidate) => candidate.origin === 'direct').length,
    ).toBe(3);
    expect(result.retrievalObservation.dropped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chunkId: 'chunk-graph-1',
          reason: 'rank_limit',
        }),
      ]),
    );
  });

  describe('edge_anchored graph expansion', () => {
    const seed = {
      ...chunkCandidate(
        'chunk-seed',
        'kp-seed',
        ['source-seed'],
        ['semantic'],
        [1, 0],
        'vacation policy seed',
      ),
      signalScore: 0.2,
    };
    const neighborChunk = (
      chunkId: string,
      pageId: string,
      distance: number,
    ) => ({
      ...chunkCandidate(
        chunkId,
        pageId,
        [`source-${pageId}`],
        ['semantic'],
        [0.5, 0.5],
        `${chunkId} body`,
      ),
      signalScore: distance,
    });
    const graphRepo = (input: {
      direct: KnowledgeChunkCandidateLike[];
      window: KnowledgeChunkCandidateLike[];
      edges: Array<{ to: string; type: 'link' | 'shared-source' }>;
    }) => ({
      findDenseChunkCandidates: jest
        .fn()
        .mockImplementation(({ knowledgePageIds, retrievalChannel }) =>
          Promise.resolve(
            knowledgePageIds
              ? input.window
              : retrievalChannel === 'evidence'
                ? input.direct
                : [],
          ),
        ),
      findLexicalChunkCandidates: jest.fn().mockResolvedValue([]),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
      findChunkSourcePageIdsByChunkIds: jest
        .fn()
        .mockImplementation(({ chunkIds }) =>
          Promise.resolve(
            [...input.direct, ...input.window]
              .filter((candidate) => chunkIds.includes(candidate.chunk.id))
              .map((candidate) => ({
                chunkId: candidate.chunk.id,
                sourcePageIds: candidate.sourcePageIds,
              })),
          ),
        ),
      findGraphFrontierSourceIds: jest.fn().mockResolvedValue(['source-edge']),
      findGraphTraversalEdges: jest.fn().mockResolvedValueOnce(
        input.edges.map((edge, index) => ({
          id: `edge-${index}`,
          fromKnowledgePageId: 'kp-seed',
          toKnowledgePageId: edge.to,
          type: edge.type,
          weight: { link: 0.7, 'shared-source': 0.2 }[edge.type],
          sourcePageIds: ['source-edge'],
        })),
      ),
    });
    const readableEverything = {
      filterReadableSources: jest
        .fn()
        .mockImplementation(({ sourcePageIds }) =>
          Promise.resolve(sourcePageIds),
        ),
    };
    const embeddingProvider = {
      embedQuery: jest.fn().mockResolvedValue(queryEmbedding()),
    };

    it('admits an edge-anchored neighbor that the legacy similarity gate drops', async () => {
      const repoInput = {
        direct: [seed],
        window: [neighborChunk('chunk-neighbor', 'kp-neighbor', 0.5)],
        edges: [{ to: 'kp-neighbor', type: 'link' as const }],
      };
      const run = (mode: 'window_recall' | 'edge_anchored') =>
        createService({
          capsuleRepo: graphRepo(repoInput),
          sourceAuthorization: readableEverything,
          embeddingProvider,
        }).retrieve({
          workspaceId: 'workspace-1',
          userId: 'user-1',
          query: 'vacation policy',
          spaceIds: ['space-1'],
          candidateLimit: 4,
          graphExpansionMode: mode,
        });

      const legacy = await run('window_recall');
      const anchored = await run('edge_anchored');

      expect(legacy.chunks.map(({ chunk }) => chunk.id)).toEqual([
        'chunk-seed',
      ]);
      expect(legacy.diagnostics.graph.expansionMode).toBe('window_recall');
      expect(
        anchored.chunks.map(({ chunk, origin }) => [chunk.id, origin]),
      ).toEqual([
        ['chunk-seed', 'direct'],
        ['chunk-neighbor', 'graph'],
      ]);
      expect(anchored.directHitChunkIds).toEqual(['chunk-seed']);
      expect(anchored.diagnostics.graph).toEqual(
        expect.objectContaining({
          expansionMode: 'edge_anchored',
          candidateCount: 1,
          gatedOutCount: 0,
          selectedCount: 1,
        }),
      );
    });

    it('still rejects a neighbor chunk that is off-topic beyond the relaxed gate', async () => {
      const result = await createService({
        capsuleRepo: graphRepo({
          direct: [seed],
          window: [neighborChunk('chunk-off-topic', 'kp-neighbor', 0.7)],
          edges: [{ to: 'kp-neighbor', type: 'link' }],
        }),
        sourceAuthorization: readableEverything,
        embeddingProvider,
      }).retrieve({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        query: 'vacation policy',
        spaceIds: ['space-1'],
        candidateLimit: 4,
        graphExpansionMode: 'edge_anchored',
      });

      expect(result.chunks.map(({ chunk }) => chunk.id)).toEqual([
        'chunk-seed',
      ]);
      expect(result.diagnostics.graph.gatedOutCount).toBe(1);
      expect(result.retrievalObservation.dropped).toEqual(
        expect.arrayContaining([
          {
            pageId: 'kp-neighbor',
            chunkId: 'chunk-off-topic',
            reason: 'below_threshold',
          },
        ]),
      );
    });

    it('keeps one chunk per neighbor and orders neighbors by edge strength, not similarity', async () => {
      const result = await createService({
        capsuleRepo: graphRepo({
          direct: [seed],
          window: [
            neighborChunk('chunk-shared-best', 'kp-shared', 0.3),
            neighborChunk('chunk-link-a', 'kp-link', 0.5),
            neighborChunk('chunk-link-b', 'kp-link', 0.52),
          ],
          edges: [
            { to: 'kp-shared', type: 'shared-source' },
            { to: 'kp-link', type: 'link' },
          ],
        }),
        sourceAuthorization: readableEverything,
        embeddingProvider,
      }).retrieve({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        query: 'vacation policy',
        spaceIds: ['space-1'],
        candidateLimit: 8,
        graphExpansionMode: 'edge_anchored',
      });

      expect(result.chunks.map(({ chunk }) => chunk.id)).toEqual([
        'chunk-seed',
        'chunk-link-a',
        'chunk-shared-best',
      ]);
    });

    it('does not expand from a seed that is only weakly relevant', async () => {
      const capsuleRepo = graphRepo({
        direct: [{ ...seed, signalScore: 0.44 }],
        window: [neighborChunk('chunk-neighbor', 'kp-neighbor', 0.3)],
        edges: [{ to: 'kp-neighbor', type: 'link' }],
      });
      const result = await createService({
        capsuleRepo,
        sourceAuthorization: readableEverything,
        embeddingProvider,
      }).retrieve({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        query: 'vacation policy',
        spaceIds: ['space-1'],
        candidateLimit: 4,
      });

      expect(result.chunks.map(({ chunk }) => chunk.id)).toEqual([
        'chunk-seed',
      ]);
      expect(result.diagnostics.graph.expandedSeedCount).toBe(0);
      expect(capsuleRepo.findGraphTraversalEdges).not.toHaveBeenCalled();
    });

    it('limits graph hits to a quarter of the slots when direct recall is full', async () => {
      const direct = Array.from({ length: 4 }, (_, index) => ({
        ...chunkCandidate(
          `chunk-direct-${index}`,
          'kp-seed',
          ['source-seed'],
          ['semantic'],
          [1, 0],
          `direct ${index}`,
        ),
        signalScore: 0.1 + index * 0.01,
      }));
      const result = await createService({
        capsuleRepo: graphRepo({
          direct,
          window: [
            neighborChunk('chunk-n1', 'kp-n1', 0.4),
            neighborChunk('chunk-n2', 'kp-n2', 0.4),
          ],
          edges: [
            { to: 'kp-n1', type: 'link' },
            { to: 'kp-n2', type: 'link' },
          ],
        }),
        sourceAuthorization: readableEverything,
        embeddingProvider,
      }).retrieve({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        query: 'vacation policy',
        spaceIds: ['space-1'],
        candidateLimit: 4,
        graphExpansionMode: 'edge_anchored',
      });

      expect(
        result.chunks.map(({ chunk, origin }) => [chunk.id, origin]),
      ).toEqual([
        ['chunk-direct-0', 'direct'],
        ['chunk-direct-1', 'direct'],
        ['chunk-direct-2', 'direct'],
        ['chunk-n1', 'graph'],
      ]);
    });
  });
});

type KnowledgeChunkCandidateLike = ReturnType<typeof chunkCandidate> & {
  signalScore?: number;
};

function createService(
  overrides: {
    userRepo?: Partial<UserRepo>;
    spaceAuthorization?: Partial<SpaceAuthorizationService>;
    capsuleRepo?: Partial<KnowledgeCapsuleRepo>;
    groupUserRepo?: Partial<GroupUserRepo>;
    sourceAuthorization?: Partial<KnowledgeSourceAuthorizationService>;
    embeddingProvider?: Partial<KnowledgeEmbeddingProvider>;
    contributionRepo?: Partial<KnowledgeArtifactContributionRepo>;
  } = {},
) {
  const userRepo = {
    findById: jest.fn().mockResolvedValue({
      id: 'user-1',
      role: UserRole.MEMBER,
      workspaceId: 'workspace-1',
    }),
    ...overrides.userRepo,
  };
  const spaceAuthorization = {
    filterReadableSpaceIds: jest.fn().mockResolvedValue(['space-1']),
    ...overrides.spaceAuthorization,
  };
  const capsuleRepo = {
    findDenseChunkCandidates: jest.fn().mockResolvedValue([]),
    findLexicalChunkCandidates: jest.fn().mockResolvedValue([]),
    findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
    findChunkSourcePageIdsByChunkIds: jest.fn().mockResolvedValue([]),
    findGraphFrontierSourceIds: jest.fn().mockResolvedValue([]),
    findGraphTraversalEdges: jest.fn().mockResolvedValue([]),
    ...overrides.capsuleRepo,
  };
  const groupUserRepo = {
    getUserGroupIds: jest.fn().mockResolvedValue([]),
    ...overrides.groupUserRepo,
  };
  const sourceAuthorization = {
    filterReadableSources: jest.fn().mockResolvedValue(['source-1']),
    ...overrides.sourceAuthorization,
  };
  const embeddingProvider = {
    embedQuery: jest.fn().mockResolvedValue(queryEmbedding()),
    ...overrides.embeddingProvider,
  };

  return new KnowledgeRetrievalService(
    userRepo as unknown as UserRepo,
    spaceAuthorization as unknown as SpaceAuthorizationService,
    capsuleRepo as unknown as KnowledgeCapsuleRepo,
    groupUserRepo as unknown as GroupUserRepo,
    sourceAuthorization as unknown as KnowledgeSourceAuthorizationService,
    embeddingProvider as unknown as ConfiguredKnowledgeEmbeddingProvider,
    new KnowledgeRetrievalRankerService(),
    overrides.contributionRepo as unknown as KnowledgeArtifactContributionRepo,
  );
}

function queryEmbedding() {
  return {
    vector: [1, 0],
    profile: 'a'.repeat(64),
    model: 'test-embedding',
    dimensions: 2,
  };
}

function candidate(id: string, spaceId: string) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId,
    compileScope: 'page',
    title: `Title ${id}`,
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

function noGraphDiagnostics() {
  return {
    graph: {
      candidateCount: 0,
      gatedOutCount: 0,
      selectedCount: 0,
      expandedSeedCount: 0,
      edgeCounts: { link: 0, 'shared-source': 0 },
      pageCountsByHop: {},
    },
  };
}

function chunkCandidate(
  chunkId: string,
  knowledgePageId: string,
  sourcePageIds: string[],
  signals: Array<'semantic' | 'lexical' | 'exact-title' | 'graph'>,
  embedding: number[] | null,
  text: string,
) {
  return {
    chunk: chunk(chunkId, knowledgePageId, embedding, text),
    page: candidate(knowledgePageId, 'space-1'),
    sourcePageIds,
    signals,
    lexicalScore: signals.includes('lexical') ? 1 : null,
  };
}
