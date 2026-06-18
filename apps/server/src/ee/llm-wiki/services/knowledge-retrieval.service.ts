import { Injectable } from '@nestjs/common';
import { GroupUserRepo } from '@docmost/db/repos/group/group-user.repo';
import { KnowledgeAccessPolicyRepo } from '@docmost/db/repos/llm-wiki/knowledge-access-policy.repo';
import {
  KnowledgeCapsuleRepo,
  KnowledgeRetrievalSignal,
} from '@docmost/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeChunk, KnowledgePage } from '@docmost/db/types/entity.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
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
    const signals = retrievalSignals(queryEmbedding);
    const sourceCandidateLimit = candidateLimit * 10;
    const candidateSourcePageIds =
      await this.capsuleRepo.findCandidateDependencySourcePageIds({
        workspaceId: input.workspaceId,
        spaceIds: readableSpaceIds,
        query: input.query,
        signals,
        sourceCandidateLimit,
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

    const chunkCandidates = await this.capsuleRepo.findSidecarEligibleChunks({
      workspaceId: input.workspaceId,
      spaceIds: readableSpaceIds,
      query: input.query,
      eligibleSourcePageIds: retrievalSourcePageIds,
      signals,
      limit: sourceCandidateLimit,
    });
    const rankedCandidates = this.ranker.rankHybridCandidates({
      query: input.query,
      queryEmbedding: queryEmbedding ?? undefined,
      candidates: chunkCandidates,
      limit: candidateLimit,
    });
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
        candidateChunkCount: chunkCandidates.length,
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
        candidateChunkCount: chunkCandidates.length,
        rankedCandidateCount: rankedCandidates.length,
        authorizedChunkCount: authorizedChunks.length,
        filteredChunkCount: rankedCandidates.length - authorizedChunks.length,
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
      rankedCandidateCount: 0,
      authorizedChunkCount: 0,
      filteredChunkCount: 0,
      ...diagnostics,
    },
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function retrievalSignals(
  queryEmbedding: number[] | null,
): KnowledgeRetrievalSignal[] {
  if (!queryEmbedding) return ['lexical', 'exact-title'];
  return ['semantic', 'lexical', 'exact-title'];
}
