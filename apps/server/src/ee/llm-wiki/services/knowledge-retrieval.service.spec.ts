import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
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
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';

describe('KnowledgeRetrievalService', () => {
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

    await expect(
      service.retrieve({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        query: 'AkashaQwenSmokeTest 是什么？',
        spaceIds: ['space-1', 'space-2'],
      }),
    ).resolves.toEqual({
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
          rankReasons: ['semantic', 'sidecar-prefiltered'],
        },
      ],
      capsules: [],
      completenessNotice:
        'Some knowledge may be unavailable because access is permission-scoped.',
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
      },
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
    expect(sourceAuthorization.filterReadableSources).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      sourcePageIds: ['source-visible', 'source-group'],
    });
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
    ).resolves.toEqual({
      mode: 'high_completeness',
      chunks: [],
      capsules: [],
      completenessNotice:
        'Some knowledge may be unavailable because access is permission-scoped.',
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
        workspaceId: 'workspace-1',
        userId: 'user-1',
        query: 'AkashaQwenSmokeTest 是什么？',
        spaceIds: ['space-1'],
      }),
    ).resolves.toEqual({
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
          rankReasons: ['lexical', 'sidecar-prefiltered'],
        },
      ],
      capsules: [],
      completenessNotice:
        'Some knowledge may be unavailable because access is permission-scoped.',
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
        rankReasons: ['semantic', 'final-authorization-fallback'],
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
});

function createService(
  overrides: {
    userRepo?: Partial<UserRepo>;
    spaceAuthorization?: Partial<SpaceAuthorizationService>;
    capsuleRepo?: Partial<KnowledgeCapsuleRepo>;
    groupUserRepo?: Partial<GroupUserRepo>;
    sourceAuthorization?: Partial<KnowledgeSourceAuthorizationService>;
    embeddingProvider?: Partial<KnowledgeEmbeddingProvider>;
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
    compileScope: 'space',
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
    claimId: null,
    text,
    contentHash: `${id}-hash`,
    embedding: embedding ? JSON.stringify(embedding) : null,
    embeddingLegacy: embedding,
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

function chunkCandidate(
  chunkId: string,
  knowledgePageId: string,
  sourcePageIds: string[],
  signals: Array<'semantic' | 'lexical' | 'exact-title'>,
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
