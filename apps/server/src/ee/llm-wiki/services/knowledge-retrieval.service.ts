import { Injectable } from '@nestjs/common';
import { GroupUserRepo } from '@akasha/db/repos/group/group-user.repo';
import { KnowledgeAccessPolicyRepo } from '@akasha/db/repos/llm-wiki/knowledge-access-policy.repo';
import {
  KnowledgeCapsuleRepo,
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
  sidecarEligibleSourceCount: number;
  sidecarFallbackSourceCount: number;
  sidecarFilteredSourceCount: number;
  candidateChunkCount: number;
  denseCandidateCount: number;
  lexicalCandidateCount: number;
  titleCandidateCount: number;
  evidenceCandidateCount: number;
  memoryCandidateCount: number;
  rankedCandidateCount: number;
  authorizedChunkCount: number;
  filteredChunkCount: number;
  fallbackReason: 'embedding_unavailable' | 'sidecar_unavailable' | null;
};

@Injectable()
export class KnowledgeRetrievalService {
  constructor(
    private readonly userRepo: UserRepo,
    private readonly spaceAuthorization: SpaceAuthorizationService,
    private readonly capsuleRepo: KnowledgeCapsuleRepo,
    private readonly accessPolicyRepo: KnowledgeAccessPolicyRepo,
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
    const candidateSourcePageIds =
      await this.capsuleRepo.findDependencySourcePageIdsForSpaces({
        workspaceId: input.workspaceId,
        spaceIds: readableSpaceIds,
      });
    if (candidateSourcePageIds.length === 0) {
      return emptyResult({
        queryEmbeddingAvailable,
        candidateSourceCount: 0,
      });
    }

    const groupIds = await this.groupUserRepo.getUserGroupIds(input.userId);
    const sidecarEligibility =
      await this.accessPolicyRepo.evaluateSourceEligibilityForPrincipals({
        workspaceId: input.workspaceId,
        sourcePageIds: candidateSourcePageIds,
        principals: [
          { principalType: 'user', principalId: input.userId },
          ...groupIds.map((groupId) => ({
            principalType: 'group' as const,
            principalId: groupId,
          })),
        ],
      });
    const eligibleSourcePageIds = sidecarEligibility
      .filter((source) => source.status === 'eligible')
      .map((source) => source.sourcePageId);
    const fallbackSourcePageIds = sidecarEligibility
      .filter(
        (source) =>
          source.status === 'missing_policy' ||
          source.status === 'stale_policy',
      )
      .map((source) => source.sourcePageId);
    const retrievalSourcePageIds =
      eligibleSourcePageIds.length > 0
        ? eligibleSourcePageIds
        : fallbackSourcePageIds;
    const mode =
      eligibleSourcePageIds.length > 0
        ? 'high_completeness'
        : 'high_completeness_fallback';
    if (retrievalSourcePageIds.length === 0) {
      return emptyResult({
        queryEmbeddingAvailable,
        candidateSourceCount: candidateSourcePageIds.length,
        sidecarEligibleSourceCount: eligibleSourcePageIds.length,
        sidecarFallbackSourceCount: fallbackSourcePageIds.length,
        sidecarFilteredSourceCount:
          candidateSourcePageIds.length -
          eligibleSourcePageIds.length -
          fallbackSourcePageIds.length,
      });
    }

    const candidateScope = {
      workspaceId: input.workspaceId,
      spaceIds: readableSpaceIds,
      eligibleSourcePageIds: retrievalSourcePageIds,
      limit: sourceCandidateLimit,
    };
    const recallChannel = (retrievalChannel: 'evidence' | 'memory') =>
      Promise.all([
        queryEmbedding
          ? this.capsuleRepo.findDenseChunkCandidates({
              ...candidateScope,
              retrievalChannel,
              embedding: queryEmbedding,
            })
          : Promise.resolve([]),
        this.capsuleRepo.findLexicalChunkCandidates({
          ...candidateScope,
          retrievalChannel,
          query: input.query,
        }),
        this.capsuleRepo.findExactTitleChunkCandidates({
          ...candidateScope,
          retrievalChannel,
          query: input.query,
        }),
      ]);
    const [evidenceRecall, memoryRecall] = await Promise.all([
      recallChannel('evidence'),
      recallChannel('memory'),
    ]);
    const [evidenceDense, evidenceLexical, evidenceTitle] = evidenceRecall;
    const [memoryDense, memoryLexical, memoryTitle] = memoryRecall;
    const denseCandidates = [...evidenceDense, ...memoryDense];
    const lexicalCandidates = [...evidenceLexical, ...memoryLexical];
    const titleCandidates = [...evidenceTitle, ...memoryTitle];
    const rankedCandidates = this.ranker.fuseRecallLists({
      recallLists: [
        { signal: 'semantic', candidates: evidenceDense },
        { signal: 'lexical', candidates: evidenceLexical },
        { signal: 'exact-title', candidates: evidenceTitle },
        { signal: 'semantic', candidates: memoryDense },
        { signal: 'lexical', candidates: memoryLexical },
        { signal: 'exact-title', candidates: memoryTitle },
      ],
      limit: candidateLimit,
    });
    const candidateChunkCount = new Set(
      [...denseCandidates, ...lexicalCandidates, ...titleCandidates].map(
        (candidate) => candidate.chunk.id,
      ),
    ).size;
    const evidenceCandidateCount = uniqueCandidateCount(evidenceRecall.flat());
    const memoryCandidateCount = uniqueCandidateCount(memoryRecall.flat());
    if (rankedCandidates.length === 0) {
      return emptyResult({
        queryEmbeddingAvailable,
        candidateSourceCount: candidateSourcePageIds.length,
        sidecarEligibleSourceCount: eligibleSourcePageIds.length,
        sidecarFallbackSourceCount: fallbackSourcePageIds.length,
        sidecarFilteredSourceCount:
          candidateSourcePageIds.length -
          eligibleSourcePageIds.length -
          fallbackSourcePageIds.length,
        candidateChunkCount,
        denseCandidateCount: uniqueCandidateCount(denseCandidates),
        lexicalCandidateCount: uniqueCandidateCount(lexicalCandidates),
        titleCandidateCount: uniqueCandidateCount(titleCandidates),
        evidenceCandidateCount,
        memoryCandidateCount,
        fallbackReason: queryEmbedding ? null : 'embedding_unavailable',
        rankedCandidateCount: 0,
      });
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

    return {
      mode,
      chunks: authorizedChunks,
      capsules: [],
      completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
      diagnostics: {
        queryEmbeddingAvailable,
        candidateSourceCount: candidateSourcePageIds.length,
        sidecarEligibleSourceCount: eligibleSourcePageIds.length,
        sidecarFallbackSourceCount: fallbackSourcePageIds.length,
        sidecarFilteredSourceCount:
          candidateSourcePageIds.length -
          eligibleSourcePageIds.length -
          fallbackSourcePageIds.length,
        candidateChunkCount,
        denseCandidateCount: uniqueCandidateCount(denseCandidates),
        lexicalCandidateCount: uniqueCandidateCount(lexicalCandidates),
        titleCandidateCount: uniqueCandidateCount(titleCandidates),
        evidenceCandidateCount,
        memoryCandidateCount,
        rankedCandidateCount: rankedCandidates.length,
        authorizedChunkCount: authorizedChunks.length,
        filteredChunkCount: rankedCandidates.length - authorizedChunks.length,
        fallbackReason:
          mode === 'high_completeness_fallback'
            ? 'sidecar_unavailable'
            : queryEmbedding
              ? null
              : 'embedding_unavailable',
      },
    };
  }
}

function emptyResult(
  diagnostics?: Partial<KnowledgeRetrievalDiagnostics>,
): KnowledgeRetrievalResult {
  return {
    mode: 'high_completeness',
    chunks: [],
    capsules: [],
    completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
    diagnostics: {
      queryEmbeddingAvailable: false,
      candidateSourceCount: 0,
      sidecarEligibleSourceCount: 0,
      sidecarFallbackSourceCount: 0,
      sidecarFilteredSourceCount: 0,
      candidateChunkCount: 0,
      denseCandidateCount: 0,
      lexicalCandidateCount: 0,
      titleCandidateCount: 0,
      evidenceCandidateCount: 0,
      memoryCandidateCount: 0,
      rankedCandidateCount: 0,
      authorizedChunkCount: 0,
      filteredChunkCount: 0,
      fallbackReason: null,
      ...diagnostics,
    },
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueCandidateCount(
  candidates: Array<{ chunk: { id: string } }>,
): number {
  return new Set(candidates.map((candidate) => candidate.chunk.id)).size;
}
