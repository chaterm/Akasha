import { KnowledgeCapsuleRepo } from '@docmost/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeAccessPolicyRepo } from '@docmost/db/repos/llm-wiki/knowledge-access-policy.repo';
import { GroupUserRepo } from '@docmost/db/repos/group/group-user.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
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
  it('uses sidecar eligibility before ranking and runs one batched final authorization pass', async () => {
    const capsuleRepo = {
      findCandidateDependencySourcePageIds: jest
        .fn()
        .mockResolvedValue(['source-visible', 'source-hidden', 'source-group']),
      findSidecarEligibleChunks: jest
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
          chunkCandidate(
            'chunk-group',
            'kp-group',
            ['source-group'],
            ['lexical'],
            [0.8, 0.2],
            'AkashaQwenSmokeTest group notes',
          ),
        ]),
      findChunkSourcePageIdsByChunkIds: jest.fn().mockResolvedValue([
        { chunkId: 'chunk-visible', sourcePageIds: ['source-visible'] },
        { chunkId: 'chunk-group', sourcePageIds: ['source-group'] },
      ]),
    };
    const accessPolicyRepo = {
      evaluateSourceEligibilityForPrincipals: jest.fn().mockResolvedValue([
        {
          sourcePageId: 'source-visible',
          sourceSpaceId: 'space-1',
          status: 'eligible',
        },
        {
          sourcePageId: 'source-hidden',
          sourceSpaceId: 'space-1',
          status: 'denied_by_restricted_ancestor',
        },
        {
          sourcePageId: 'source-group',
          sourceSpaceId: 'space-1',
          status: 'eligible',
        },
      ]),
    };
    const sourceAuthorization = {
      filterReadableSources: jest.fn().mockResolvedValue(['source-visible']),
    };
    const embeddingProvider = {
      embedQuery: jest.fn().mockResolvedValue([1, 0]),
    };
    const service = createService({
      capsuleRepo,
      accessPolicyRepo,
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
        candidateSourceCount: 3,
        sidecarEligibleSourceCount: 2,
        sidecarFallbackSourceCount: 0,
        sidecarFilteredSourceCount: 1,
        candidateChunkCount: 2,
        rankedCandidateCount: 2,
        authorizedChunkCount: 1,
        filteredChunkCount: 1,
      },
    });

    expect(embeddingProvider.embedQuery).toHaveBeenCalledWith(
      'AkashaQwenSmokeTest 是什么？',
    );
    expect(
      capsuleRepo.findCandidateDependencySourcePageIds,
    ).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      query: 'AkashaQwenSmokeTest 是什么？',
      signals: ['semantic', 'lexical', 'exact-title'],
      sourceCandidateLimit: 200,
    });
    expect(
      accessPolicyRepo.evaluateSourceEligibilityForPrincipals,
    ).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['source-visible', 'source-hidden', 'source-group'],
      principals: [
        { principalType: 'user', principalId: 'user-1' },
        { principalType: 'group', principalId: 'group-1' },
      ],
    });
    expect(capsuleRepo.findSidecarEligibleChunks).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      query: 'AkashaQwenSmokeTest 是什么？',
      eligibleSourcePageIds: ['source-visible', 'source-group'],
      signals: ['semantic', 'lexical', 'exact-title'],
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
      findCandidateDependencySourcePageIds: jest.fn(),
      findSidecarEligibleChunks: jest.fn(),
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
        sidecarEligibleSourceCount: 0,
        sidecarFallbackSourceCount: 0,
        sidecarFilteredSourceCount: 0,
        candidateChunkCount: 0,
        rankedCandidateCount: 0,
        authorizedChunkCount: 0,
        filteredChunkCount: 0,
      },
    });

    expect(
      capsuleRepo.findCandidateDependencySourcePageIds,
    ).not.toHaveBeenCalled();
  });

  it('caps sidecar source discovery independently from final answer count', async () => {
    const capsuleRepo = {
      findCandidateDependencySourcePageIds: jest
        .fn()
        .mockResolvedValue(['source-1']),
      findSidecarEligibleChunks: jest
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
      accessPolicyRepo: {
        evaluateSourceEligibilityForPrincipals: jest.fn().mockResolvedValue([
          {
            sourcePageId: 'source-1',
            sourceSpaceId: 'space-1',
            status: 'eligible',
          },
        ]),
      },
      embeddingProvider: { embedQuery: jest.fn().mockResolvedValue([1, 0]) },
    });

    const result = await service.retrieve({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'kafka',
      spaceIds: ['space-1'],
      candidateLimit: 5,
    });

    expect(
      capsuleRepo.findCandidateDependencySourcePageIds,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ sourceCandidateLimit: 50 }),
    );
    expect(capsuleRepo.findSidecarEligibleChunks).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
    expect(capsuleRepo.findChunkSourcePageIdsByChunkIds).toHaveBeenCalledTimes(
      1,
    );
    expect(result.chunks).toHaveLength(5);
  });

  it('falls back to lexical retrieval when query embedding is unavailable', async () => {
    const capsuleRepo = {
      findCandidateDependencySourcePageIds: jest
        .fn()
        .mockResolvedValue(['source-lexical']),
      findSidecarEligibleChunks: jest
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
      findChunkSourcePageIdsByChunkIds: jest
        .fn()
        .mockResolvedValue([
          { chunkId: 'chunk-lexical', sourcePageIds: ['source-lexical'] },
        ]),
    };
    const service = createService({
      capsuleRepo,
      accessPolicyRepo: {
        evaluateSourceEligibilityForPrincipals: jest.fn().mockResolvedValue([
          {
            sourcePageId: 'source-lexical',
            sourceSpaceId: 'space-1',
            status: 'eligible',
          },
        ]),
      },
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
        sidecarEligibleSourceCount: 1,
        sidecarFallbackSourceCount: 0,
        sidecarFilteredSourceCount: 0,
        candidateChunkCount: 1,
        rankedCandidateCount: 1,
        authorizedChunkCount: 1,
        filteredChunkCount: 0,
      },
    });

    expect(capsuleRepo.findSidecarEligibleChunks).toHaveBeenCalledWith(
      expect.objectContaining({
        signals: ['lexical', 'exact-title'],
      }),
    );
  });

  it('uses a named high-completeness fallback when sidecar policies are missing or stale', async () => {
    const capsuleRepo = {
      findCandidateDependencySourcePageIds: jest
        .fn()
        .mockResolvedValue(['source-missing', 'source-stale']),
      findSidecarEligibleChunks: jest
        .fn()
        .mockResolvedValue([
          chunkCandidate(
            'chunk-fallback',
            'kp-fallback',
            ['source-missing'],
            ['semantic'],
            [1, 0],
            'Fallback candidate',
          ),
        ]),
      findChunkSourcePageIdsByChunkIds: jest
        .fn()
        .mockResolvedValue([
          { chunkId: 'chunk-fallback', sourcePageIds: ['source-missing'] },
        ]),
    };
    const service = createService({
      capsuleRepo,
      accessPolicyRepo: {
        evaluateSourceEligibilityForPrincipals: jest.fn().mockResolvedValue([
          {
            sourcePageId: 'source-missing',
            sourceSpaceId: null,
            status: 'missing_policy',
          },
          {
            sourcePageId: 'source-stale',
            sourceSpaceId: 'space-1',
            status: 'stale_policy',
          },
        ]),
      },
      sourceAuthorization: {
        filterReadableSources: jest.fn().mockResolvedValue(['source-missing']),
      },
    });

    await expect(
      service.retrieve({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        query: 'fallback',
        spaceIds: ['space-1'],
      }),
    ).resolves.toEqual({
      mode: 'high_completeness_fallback',
      chunks: [
        {
          chunk: chunk(
            'chunk-fallback',
            'kp-fallback',
            [1, 0],
            'Fallback candidate',
          ),
          page: candidate('kp-fallback', 'space-1'),
          sourcePageIds: ['source-missing'],
          rankReasons: ['semantic', 'sidecar-prefiltered'],
        },
      ],
      capsules: [],
      completenessNotice:
        'Some knowledge may be unavailable because access is permission-scoped.',
      diagnostics: {
        queryEmbeddingAvailable: true,
        candidateSourceCount: 2,
        sidecarEligibleSourceCount: 0,
        sidecarFallbackSourceCount: 2,
        sidecarFilteredSourceCount: 0,
        candidateChunkCount: 1,
        rankedCandidateCount: 1,
        authorizedChunkCount: 1,
        filteredChunkCount: 0,
      },
    });

    expect(capsuleRepo.findSidecarEligibleChunks).toHaveBeenCalledWith(
      expect.objectContaining({
        eligibleSourcePageIds: ['source-missing', 'source-stale'],
      }),
    );
  });
});

function createService(
  overrides: {
    userRepo?: Partial<UserRepo>;
    spaceAuthorization?: Partial<SpaceAuthorizationService>;
    capsuleRepo?: Partial<KnowledgeCapsuleRepo>;
    accessPolicyRepo?: Partial<KnowledgeAccessPolicyRepo>;
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
    findCandidateDependencySourcePageIds: jest.fn().mockResolvedValue([]),
    findSidecarEligibleChunks: jest.fn().mockResolvedValue([]),
    findChunkSourcePageIdsByChunkIds: jest.fn().mockResolvedValue([]),
    ...overrides.capsuleRepo,
  };
  const accessPolicyRepo = {
    evaluateSourceEligibilityForPrincipals: jest.fn().mockResolvedValue([]),
    ...overrides.accessPolicyRepo,
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
    embedQuery: jest.fn().mockResolvedValue([1, 0]),
    ...overrides.embeddingProvider,
  };

  return new KnowledgeRetrievalService(
    userRepo as unknown as UserRepo,
    spaceAuthorization as unknown as SpaceAuthorizationService,
    capsuleRepo as unknown as KnowledgeCapsuleRepo,
    accessPolicyRepo as unknown as KnowledgeAccessPolicyRepo,
    groupUserRepo as unknown as GroupUserRepo,
    sourceAuthorization as unknown as KnowledgeSourceAuthorizationService,
    embeddingProvider as unknown as ConfiguredKnowledgeEmbeddingProvider,
    new KnowledgeRetrievalRankerService(),
  );
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
