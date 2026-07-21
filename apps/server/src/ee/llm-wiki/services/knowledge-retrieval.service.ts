import { Injectable } from '@nestjs/common';
import { GroupUserRepo } from '@akasha/db/repos/group/group-user.repo';
import {
  KnowledgeCapsuleRepo,
  KnowledgeChunkCandidate,
  KnowledgeRetrievalSignal,
} from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeChunk, KnowledgePage } from '@akasha/db/types/entity.types';
import type { KnowledgeParentSection } from '@akasha/db/types/entity.types';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { SpaceAuthorizationService } from '../../../core/space/services/space-authorization.service';
import { ConfiguredKnowledgeEmbeddingProvider } from './knowledge-embedding-provider.service';
import {
  KnowledgeRetrievalRankReason,
  KnowledgeRetrievalRankerService,
} from './knowledge-retrieval-ranker.service';
import { KnowledgeSourceAuthorizationService } from './knowledge-source-authorization.service';

export const KNOWLEDGE_COMPLETENESS_NOTICE =
  'Some knowledge may be unavailable because access is permission-scoped.';

export type KnowledgeRetrievalResult = {
  mode: 'high_completeness' | 'high_completeness_fallback';
  chunks: Array<{
    chunk: KnowledgeChunk;
    page: KnowledgePage;
    sourcePageIds: string[];
    rankReasons: KnowledgeRetrievalRankReason[];
    parentSection?: KnowledgeParentSection;
  }>;
  capsules: KnowledgePage[];
  completenessNotice: typeof KNOWLEDGE_COMPLETENESS_NOTICE;
  diagnostics: KnowledgeRetrievalDiagnostics;
};

export type KnowledgeRetrievalDiagnostics = {
  queryEmbeddingAvailable: boolean;
  candidateSourceCount: number;
  policyCandidateSourceCount: number;
  fallbackCandidateSourceCount: number;
  finalAuthorizedSourceCount: number;
  accessPolicyFallbackUsed: boolean;
  candidateChunkCount: number;
  denseCandidateCount: number;
  lexicalCandidateCount: number;
  titleCandidateCount: number;
  evidenceCandidateCount: number;
  memoryCandidateCount: number;
  rankedCandidateCount: number;
  authorizedChunkCount: number;
  filteredChunkCount: number;
};

@Injectable()
export class KnowledgeRetrievalService {
  constructor(
    private readonly userRepo: UserRepo,
    private readonly spaceAuthorization: SpaceAuthorizationService,
    private readonly capsuleRepo: KnowledgeCapsuleRepo,
    private readonly groupUserRepo: GroupUserRepo,
    private readonly sourceAuthorization: KnowledgeSourceAuthorizationService,
    private readonly embeddingProvider: ConfiguredKnowledgeEmbeddingProvider,
    private readonly ranker: KnowledgeRetrievalRankerService,
  ) {}

  async retrieve(input: {
    workspaceId: string;
    userId: string;
    query: string;
    spaceIds: string[];
    candidateLimit?: number;
  }): Promise<KnowledgeRetrievalResult> {
    const candidateLimit = input.candidateLimit ?? 20;
    const user = await this.userRepo.findById(input.userId, input.workspaceId);
    if (!user) {
      return emptyResult();
    }

    const readableSpaceIds =
      await this.spaceAuthorization.filterReadableSpaceIds({
        user,
        spaceIds: unique(input.spaceIds),
      });
    if (readableSpaceIds.length === 0) {
      return emptyResult();
    }

    const queryEmbedding = await this.embeddingProvider.embedQuery(input.query);
    const queryEmbeddingAvailable = Boolean(queryEmbedding);
    const sourceCandidateLimit = candidateLimit * 10;
    const groupIds = await this.groupUserRepo.getUserGroupIds(input.userId);
    const principals = [
      { principalType: 'user' as const, principalId: input.userId },
      ...groupIds.map((groupId) => ({
        principalType: 'group' as const,
        principalId: groupId,
      })),
    ];
    const candidateScope = {
      workspaceId: input.workspaceId,
      spaceIds: readableSpaceIds,
      principals,
      limit: sourceCandidateLimit,
    };
    const recallChannel = (
      retrievalChannel: 'evidence' | 'memory',
      authorizationMode: 'policy' | 'final-authorization-fallback',
    ) =>
      Promise.all([
        queryEmbedding
          ? this.capsuleRepo.findDenseChunkCandidates({
              ...candidateScope,
              retrievalChannel,
              authorizationMode,
              embedding: queryEmbedding,
            })
          : Promise.resolve([]),
        this.capsuleRepo.findLexicalChunkCandidates({
          ...candidateScope,
          retrievalChannel,
          authorizationMode,
          query: input.query,
        }),
        this.capsuleRepo.findExactTitleChunkCandidates({
          ...candidateScope,
          retrievalChannel,
          authorizationMode,
          query: input.query,
        }),
      ]);
    const recall = (
      authorizationMode: 'policy' | 'final-authorization-fallback',
    ) =>
      Promise.all([
        recallChannel('evidence', authorizationMode),
        recallChannel('memory', authorizationMode),
      ]);
    const policyRecall = await recall('policy');
    let selectedRecall = policyRecall;
    let accessPolicyFallbackUsed = false;

    let rankedCandidates = fuseRecall(
      this.ranker,
      selectedRecall,
      candidateLimit,
    );
    let fallbackRecall: Awaited<ReturnType<typeof recall>> | null = null;
    if (rankedCandidates.length === 0) {
      accessPolicyFallbackUsed = true;
      fallbackRecall = await recall('final-authorization-fallback');
      selectedRecall = fallbackRecall;
      rankedCandidates = fuseRecall(
        this.ranker,
        selectedRecall,
        candidateLimit,
      ).map((candidate) => ({
        ...candidate,
        rankReasons: [
          ...candidate.rankReasons.filter(
            (reason) => reason !== 'sidecar-prefiltered',
          ),
          'final-authorization-fallback' as const,
        ],
      }));
    }

    const [evidenceRecall, memoryRecall] = selectedRecall;
    const [evidenceDense, evidenceLexical, evidenceTitle] = evidenceRecall;
    const [memoryDense, memoryLexical, memoryTitle] = memoryRecall;
    const denseCandidates = [...evidenceDense, ...memoryDense];
    const lexicalCandidates = [...evidenceLexical, ...memoryLexical];
    const titleCandidates = [...evidenceTitle, ...memoryTitle];
    const candidateChunkCount = new Set(
      [...denseCandidates, ...lexicalCandidates, ...titleCandidates].map(
        (candidate) => candidate.chunk.id,
      ),
    ).size;
    const evidenceCandidateCount = uniqueCandidateCount(evidenceRecall.flat());
    const memoryCandidateCount = uniqueCandidateCount(memoryRecall.flat());
    const candidateSourcePageIds = unique(
      [...denseCandidates, ...lexicalCandidates, ...titleCandidates].flatMap(
        (candidate) => candidate.sourcePageIds,
      ),
    );
    const policyCandidateSourcePageIds = candidateSourceIds(policyRecall);
    const fallbackCandidateSourcePageIds = fallbackRecall
      ? candidateSourceIds(fallbackRecall)
      : [];
    if (rankedCandidates.length === 0) {
      return emptyResult(
        {
          queryEmbeddingAvailable,
          candidateSourceCount: candidateSourcePageIds.length,
          policyCandidateSourceCount: policyCandidateSourcePageIds.length,
          fallbackCandidateSourceCount: fallbackCandidateSourcePageIds.length,
          accessPolicyFallbackUsed,
          candidateChunkCount,
          denseCandidateCount: uniqueCandidateCount(denseCandidates),
          lexicalCandidateCount: uniqueCandidateCount(lexicalCandidates),
          titleCandidateCount: uniqueCandidateCount(titleCandidates),
          evidenceCandidateCount,
          memoryCandidateCount,
          rankedCandidateCount: 0,
        },
        'high_completeness_fallback',
      );
    }

    const sourceRows = await this.capsuleRepo.findChunkSourcePageIdsByChunkIds({
      workspaceId: input.workspaceId,
      chunkIds: rankedCandidates.map((candidate) => candidate.chunk.id),
    });
    const sourcesByChunkId = new Map(
      sourceRows.map((row) => [row.chunkId, row.sourcePageIds]),
    );
    const allSourcePageIds = unique(
      sourceRows.flatMap((row) => row.sourcePageIds),
    );
    const readableSourcePageIds =
      await this.sourceAuthorization.filterReadableSources({
        workspaceId: input.workspaceId,
        userId: input.userId,
        sourcePageIds: allSourcePageIds,
      });
    const readableSourceSet = new Set(readableSourcePageIds);

    const authorizedChunks: KnowledgeRetrievalResult['chunks'] = [];
    for (const candidate of rankedCandidates) {
      const sourcePageIds =
        sourcesByChunkId.get(candidate.chunk.id) ?? candidate.sourcePageIds;
      if (
        sourcePageIds.length > 0 &&
        sourcePageIds.every((sourcePageId) =>
          readableSourceSet.has(sourcePageId),
        )
      ) {
        authorizedChunks.push({
          chunk: candidate.chunk,
          page: candidate.page,
          sourcePageIds,
          rankReasons: candidate.rankReasons,
          ...(candidate.parentSection
            ? { parentSection: candidate.parentSection }
            : {}),
        });
      }
    }
    const finalAuthorizedSourceCount = unique(
      authorizedChunks.flatMap((candidate) => candidate.sourcePageIds),
    ).length;

    return {
      mode: accessPolicyFallbackUsed
        ? 'high_completeness_fallback'
        : 'high_completeness',
      chunks: authorizedChunks,
      capsules: [],
      completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
      diagnostics: {
        queryEmbeddingAvailable,
        candidateSourceCount: candidateSourcePageIds.length,
        policyCandidateSourceCount: policyCandidateSourcePageIds.length,
        fallbackCandidateSourceCount: fallbackCandidateSourcePageIds.length,
        finalAuthorizedSourceCount,
        accessPolicyFallbackUsed,
        candidateChunkCount,
        denseCandidateCount: uniqueCandidateCount(denseCandidates),
        lexicalCandidateCount: uniqueCandidateCount(lexicalCandidates),
        titleCandidateCount: uniqueCandidateCount(titleCandidates),
        evidenceCandidateCount,
        memoryCandidateCount,
        rankedCandidateCount: rankedCandidates.length,
        authorizedChunkCount: authorizedChunks.length,
        filteredChunkCount: rankedCandidates.length - authorizedChunks.length,
      },
    };
  }
}

function emptyResult(
  diagnostics?: Partial<KnowledgeRetrievalDiagnostics>,
  mode: KnowledgeRetrievalResult['mode'] = 'high_completeness',
): KnowledgeRetrievalResult {
  return {
    mode,
    chunks: [],
    capsules: [],
    completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
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
      ...diagnostics,
    },
  };
}

function fuseRecall(
  ranker: KnowledgeRetrievalRankerService,
  recall: [
    [
      KnowledgeChunkCandidate[],
      KnowledgeChunkCandidate[],
      KnowledgeChunkCandidate[],
    ],
    [
      KnowledgeChunkCandidate[],
      KnowledgeChunkCandidate[],
      KnowledgeChunkCandidate[],
    ],
  ],
  limit: number,
) {
  const [evidenceRecall, memoryRecall] = recall;
  const [evidenceDense, evidenceLexical, evidenceTitle] = evidenceRecall;
  const [memoryDense, memoryLexical, memoryTitle] = memoryRecall;
  return ranker.fuseRecallLists({
    recallLists: [
      { signal: 'semantic', candidates: evidenceDense },
      { signal: 'lexical', candidates: evidenceLexical },
      { signal: 'exact-title', candidates: evidenceTitle },
      { signal: 'semantic', candidates: memoryDense },
      { signal: 'lexical', candidates: memoryLexical },
      { signal: 'exact-title', candidates: memoryTitle },
    ],
    limit,
  });
}

function candidateSourceIds(
  recall: [
    [
      KnowledgeChunkCandidate[],
      KnowledgeChunkCandidate[],
      KnowledgeChunkCandidate[],
    ],
    [
      KnowledgeChunkCandidate[],
      KnowledgeChunkCandidate[],
      KnowledgeChunkCandidate[],
    ],
  ],
): string[] {
  return unique(recall.flat(2).flatMap((candidate) => candidate.sourcePageIds));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueCandidateCount(
  candidates: Array<{ chunk: { id: string } }>,
): number {
  return new Set(candidates.map((candidate) => candidate.chunk.id)).size;
}
