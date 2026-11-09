import { Injectable, Optional } from '@nestjs/common';
import { GroupUserRepo } from '@akasha/db/repos/group/group-user.repo';
import { KnowledgeArtifactContributionRepo } from '@akasha/db/repos/llm-wiki/knowledge-artifact-contribution.repo';
import {
  KnowledgeCapsuleRepo,
  KnowledgeChunkCandidate,
  KnowledgeGraphEdgeType,
  KnowledgeGraphTraversalEdge,
  KnowledgeGraphTraversalSeed,
  KnowledgeRetrievalSignal,
} from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeChunk, KnowledgePage } from '@akasha/db/types/entity.types';
import type { KnowledgeParentSection } from '@akasha/db/types/entity.types';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { SpaceAuthorizationService } from '../../../core/space/services/space-authorization.service';
import { ConfiguredKnowledgeEmbeddingProvider } from './knowledge-embedding-provider.service';
import {
  DEFAULT_MAX_RELEVANT_COSINE_DISTANCE,
  KnowledgeRankedChunkCandidate,
  KnowledgeRetrievalRankReason,
  KnowledgeRetrievalRankerService,
} from './knowledge-retrieval-ranker.service';
import { KnowledgeSourceAuthorizationService } from './knowledge-source-authorization.service';
import { KnowledgeAuthorizationCache } from './knowledge-source-authorization.cache';
import {
  AiChatDebugTiming,
  measureAiChatPhase,
} from '../../../common/observability/ai-chat-debug-timing';

export const KNOWLEDGE_COMPLETENESS_NOTICE =
  'Some knowledge may be unavailable because access is permission-scoped.';

/** Whether a chunk entered the result via direct recall or graph expansion. */
export type KnowledgeRetrievalOrigin = 'direct' | 'graph';

/**
 * How graph neighbors turn into chunk candidates.
 * - window_recall: re-recall neighbor chunks by query similarity and fuse them
 *   with direct hits under the same relevance gate (legacy behavior).
 * - edge_anchored: the traversed edge vouches for the neighbor page; pick its
 *   best chunk under a looser gate and rank it by edge strength in a reserved
 *   slice, so graph hits no longer compete with direct hits on similarity.
 */
export type KnowledgeGraphExpansionMode = 'window_recall' | 'edge_anchored';

/** Which authorization path admitted the chunk. */
export type KnowledgeRetrievalAuthorizationMode =
  | 'policy'
  | 'final-authorization-fallback';

export type KnowledgeRetrievalCandidate = {
  pageId: string;
  chunkId: string;
  score: number;
  scoreType: 'semantic_distance' | 'lexical' | 'exact_title';
  reasons: KnowledgeRetrievalRankReason[];
  stage: 'direct' | 'graph';
  authorizationMode: 'policy' | 'fallback';
};

export type KnowledgeRetrievalDrop = {
  pageId: string;
  chunkId: string;
  reason: 'below_threshold' | 'filtered' | 'unauthorized' | 'rank_limit';
};

export type KnowledgeRetrievalObservation = {
  attempted: boolean;
  candidates: KnowledgeRetrievalCandidate[];
  dropped: KnowledgeRetrievalDrop[];
  topK: number;
  threshold: number;
};

export type KnowledgeRetrievalResult = {
  mode: 'high_completeness' | 'high_completeness_fallback';
  chunks: Array<{
    chunk: KnowledgeChunk;
    page: KnowledgePage;
    sourcePageIds: string[];
    rankReasons: KnowledgeRetrievalRankReason[];
    // Recorded before direct/graph merge so downstream consumers never have to
    // infer the source from rankReasons text (§7.1).
    origin: KnowledgeRetrievalOrigin;
    authorizationMode: KnowledgeRetrievalAuthorizationMode;
    parentSection?: KnowledgeParentSection;
  }>;
  capsules: KnowledgePage[];
  completenessNotice: typeof KNOWLEDGE_COMPLETENESS_NOTICE;
  scope: KnowledgeRetrievalScope;
  diagnostics: KnowledgeRetrievalDiagnostics;
  // Direct-hit chunk ids that survived final selection, in retrieval-rank
  // order. Populated before citation resolution rewrites parent bodies or the
  // context budget truncates chunks (§7.1).
  directHitChunkIds: string[];
  retrievalObservation: KnowledgeRetrievalObservation;
};

export type KnowledgeRetrievalScope = {
  requestedSpaceIds: string[];
  effectiveSpaceIds: string[];
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
  graph: {
    expansionMode?: KnowledgeGraphExpansionMode;
    candidateCount: number;
    gatedOutCount: number;
    selectedCount: number;
    expandedSeedCount: number;
    edgeCounts: Record<KnowledgeGraphEdgeType, number>;
    pageCountsByHop: Record<number, number>;
  };
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
    @Optional()
    private readonly contributionRepo?: KnowledgeArtifactContributionRepo,
  ) {}

  async retrieve(input: {
    workspaceId: string;
    userId: string;
    supplementalUserId?: string;
    query: string;
    spaceIds: string[];
    labelNames?: string[];
    candidateLimit?: number;
    /** Maximum semantic cosine distance accepted during recall. */
    maxCosineDistance?: number;
    abortSignal?: AbortSignal;
    authCache?: KnowledgeAuthorizationCache;
    debugTiming?: AiChatDebugTiming;
    /** Defaults to edge_anchored; window_recall is kept for A/B evaluation. */
    graphExpansionMode?: KnowledgeGraphExpansionMode;
  }): Promise<KnowledgeRetrievalResult> {
    const candidateLimit = input.candidateLimit ?? 20;
    const graphExpansionMode = input.graphExpansionMode ?? 'edge_anchored';
    const maxCosineDistance =
      input.maxCosineDistance ?? DEFAULT_MAX_RELEVANT_COSINE_DISTANCE;
    const requestedSpaceIds = unique(input.spaceIds);
    const emptyScope: KnowledgeRetrievalScope = {
      requestedSpaceIds,
      effectiveSpaceIds: [],
    };
    const emptyRetrievalObservation = (): KnowledgeRetrievalObservation => ({
      attempted: false,
      candidates: [],
      dropped: [],
      topK: candidateLimit,
      threshold:
        input.maxCosineDistance ?? DEFAULT_MAX_RELEVANT_COSINE_DISTANCE,
    });
    const authCache =
      input.authCache ??
      new KnowledgeAuthorizationCache({
        workspaceId: input.workspaceId,
        userId: input.userId,
      });
    // Fail closed before reading anything from the cache: a cache bound to a
    // different (workspace, user) must never drive this user's retrieval.
    try {
      authCache.assertScope(input.workspaceId, input.userId);
    } catch {
      return emptyResult({
        scope: emptyScope,
        retrievalObservation: emptyRetrievalObservation(),
      });
    }

    const user = await measureAiChatPhase(
      input.debugTiming,
      'retrieval.load_user',
      () =>
        authCache.getUser(() =>
          this.userRepo.findById(input.userId, input.workspaceId),
        ),
      (result) => ({ userFound: Boolean(result) }),
    );
    if (!user) {
      return emptyResult({
        scope: emptyScope,
        retrievalObservation: emptyRetrievalObservation(),
      });
    }

    const readableSpaceIds = await measureAiChatPhase(
      input.debugTiming,
      'retrieval.authorize_spaces',
      () =>
        this.spaceAuthorization.filterReadableSpaceIds({
          user,
          spaceIds: requestedSpaceIds,
        }),
      (result) => ({
        requestedSpaceCount: requestedSpaceIds.length,
        readableSpaceCount: result.length,
      }),
    );
    // Reuse this space-readability decision for the source authorization passes
    // later in this request instead of re-querying the same spaces.
    authCache.recordSpaces(requestedSpaceIds, new Set(readableSpaceIds));
    if (readableSpaceIds.length === 0) {
      return emptyResult({
        scope: {
          requestedSpaceIds,
          effectiveSpaceIds: [],
        },
        retrievalObservation: emptyRetrievalObservation(),
      });
    }

    const queryEmbedding = await measureAiChatPhase(
      input.debugTiming,
      'retrieval.embed_query',
      () =>
        input.abortSignal
          ? this.embeddingProvider.embedQuery(input.query, {
              abortSignal: input.abortSignal,
            })
          : this.embeddingProvider.embedQuery(input.query),
      (result) => ({
        embeddingAvailable: Boolean(result),
        embeddingDimensions: result?.dimensions ?? 0,
        embeddingModel: result?.model,
      }),
    );
    const queryEmbeddingAvailable = Boolean(queryEmbedding);
    const sourceCandidateLimit = candidateLimit * 10;
    const groupIds = await measureAiChatPhase(
      input.debugTiming,
      'retrieval.load_principals',
      () => this.groupUserRepo.getUserGroupIds(input.userId),
      (result) => ({ groupCount: result.length }),
    );
    const supplementalGroupIds = input.supplementalUserId
      ? await this.groupUserRepo.getUserGroupIds(input.supplementalUserId)
      : [];
    const principals = [
      { principalType: 'user' as const, principalId: input.userId },
      ...groupIds.map((groupId) => ({
        principalType: 'group' as const,
        principalId: groupId,
      })),
      ...(input.supplementalUserId
        ? [
            {
              principalType: 'user' as const,
              principalId: input.supplementalUserId,
            },
            ...supplementalGroupIds.map((groupId) => ({
              principalType: 'group' as const,
              principalId: groupId,
            })),
          ]
        : []),
    ];
    const candidateScope = {
      workspaceId: input.workspaceId,
      spaceIds: readableSpaceIds,
      principals,
      limit: sourceCandidateLimit,
      ...(input.labelNames?.length ? { labelNames: input.labelNames } : {}),
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
    const policyRecall = await measureAiChatPhase(
      input.debugTiming,
      'retrieval.policy_recall',
      () => recall('policy'),
      (result) => recallCounts(result),
    );
    let selectedRecall = policyRecall;
    let accessPolicyFallbackUsed = false;

    const rankRecallCandidates = (
      recallResult: typeof selectedRecall,
      graph?: {
        dense: KnowledgeChunkCandidate[];
        lexical: KnowledgeChunkCandidate[];
      },
    ) => fuseRecall(this.ranker, recallResult, candidateLimit, graph);
    const filterRelevantCandidates = (
      candidates: ReturnType<typeof rankRecallCandidates>,
    ) =>
      candidates.filter((candidate) =>
        this.ranker.isCandidateRelevant({
          candidate,
          maxCosineDistance: input.maxCosineDistance,
        }),
      );
    let rankingStartedAt = performance.now();
    let fusedCandidatesBeforeGate = rankRecallCandidates(selectedRecall);
    let rankedCandidates = filterRelevantCandidates(fusedCandidatesBeforeGate);
    input.debugTiming?.record(
      'retrieval.rank_candidates',
      performance.now() - rankingStartedAt,
      { rankedCandidateCount: rankedCandidates.length, pass: 'policy' },
    );
    let fallbackRecall: Awaited<ReturnType<typeof recall>> | null = null;
    if (rankedCandidates.length === 0) {
      accessPolicyFallbackUsed = true;
      fallbackRecall = await measureAiChatPhase(
        input.debugTiming,
        'retrieval.fallback_recall',
        () => recall('final-authorization-fallback'),
        (result) => recallCounts(result),
      );
      selectedRecall = fallbackRecall;
      rankingStartedAt = performance.now();
      fusedCandidatesBeforeGate = rankRecallCandidates(selectedRecall);
      rankedCandidates = filterRelevantCandidates(fusedCandidatesBeforeGate);
      input.debugTiming?.record(
        'retrieval.rank_candidates',
        performance.now() - rankingStartedAt,
        { rankedCandidateCount: rankedCandidates.length, pass: 'fallback' },
      );
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
      return emptyResult({
        scope: {
          requestedSpaceIds,
          effectiveSpaceIds: readableSpaceIds,
        },
        diagnostics: {
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
        mode: 'high_completeness_fallback',
        retrievalObservation: {
          attempted: true,
          candidates: toRawRetrievalCandidates({
            policyRecall,
            fallbackRecall,
            topK: candidateLimit,
          }),
          dropped: buildRetrievalDrops({
            candidates: toRawRetrievalCandidates({
              policyRecall,
              fallbackRecall,
              topK: candidateLimit,
            }),
            selectedChunkIds: new Set(),
            relevantChunkIds: new Set(
              rankedCandidates.map((candidate) => candidate.chunk.id),
            ),
            authorizedChunkIds: new Set(),
            threshold:
              input.maxCosineDistance ?? DEFAULT_MAX_RELEVANT_COSINE_DISTANCE,
          }),
          topK: candidateLimit,
          threshold:
            input.maxCosineDistance ?? DEFAULT_MAX_RELEVANT_COSINE_DISTANCE,
        },
      });
    }

    const sourceRows = await measureAiChatPhase(
      input.debugTiming,
      'retrieval.load_chunk_sources',
      () =>
        this.capsuleRepo.findChunkSourcePageIdsByChunkIds({
          workspaceId: input.workspaceId,
          chunkIds: rankedCandidates.map((candidate) => candidate.chunk.id),
        }),
      (result) => ({ sourceRowCount: result.length }),
    );
    const sourcesByChunkId = new Map(
      sourceRows.map((row) => [row.chunkId, row.sourcePageIds]),
    );
    const allSourcePageIds = unique(
      sourceRows.flatMap((row) => row.sourcePageIds),
    );
    const readableSourcePageIds = await measureAiChatPhase(
      input.debugTiming,
      'retrieval.authorize_sources',
      () =>
        this.sourceAuthorization.filterReadableSources({
          workspaceId: input.workspaceId,
          userId: input.userId,
          supplementalUserId: input.supplementalUserId,
          sourcePageIds: allSourcePageIds,
          cache: authCache,
        }),
      (result) => ({
        candidateSourceCount: allSourcePageIds.length,
        readableSourceCount: result.length,
      }),
    );
    const readableSourceSet = new Set(readableSourcePageIds);

    const directChunkIds = new Set(
      selectedRecall.flat(2).map((candidate) => candidate.chunk.id),
    );
    const authorizeRanked = (
      candidates: typeof rankedCandidates,
      sources: Map<string, string[]>,
      readable: Set<string>,
    ): KnowledgeRetrievalResult['chunks'] => {
      const authorized: KnowledgeRetrievalResult['chunks'] = [];
      for (const candidate of candidates) {
        const sourcePageIds =
          sources.get(candidate.chunk.id) ?? candidate.sourcePageIds;
        if (
          sourcePageIds.length > 0 &&
          sourcePageIds.every((sourcePageId) => readable.has(sourcePageId))
        ) {
          authorized.push({
            chunk: candidate.chunk,
            page: candidate.page,
            sourcePageIds,
            rankReasons: candidate.rankReasons,
            origin:
              candidate.signals.includes('graph') &&
              !directChunkIds.has(candidate.chunk.id)
                ? 'graph'
                : 'direct',
            authorizationMode: accessPolicyFallbackUsed
              ? 'final-authorization-fallback'
              : 'policy',
            ...(candidate.parentSection
              ? { parentSection: candidate.parentSection }
              : {}),
          });
        }
      }
      return authorized;
    };
    const authorizedChunks = authorizeRanked(
      rankedCandidates,
      sourcesByChunkId,
      readableSourceSet,
    );
    const authorizedChunkIds = new Set(
      authorizedChunks.map((candidate) => candidate.chunk.id),
    );
    const relevantChunkIds = new Set(
      rankedCandidates.map((candidate) => candidate.chunk.id),
    );
    const seedWeightByPageId = new Map<string, number>();
    for (const candidate of rankedCandidates) {
      const pageId = candidate.page.id;
      seedWeightByPageId.set(
        pageId,
        Math.max(seedWeightByPageId.get(pageId) ?? 0, candidate.score),
      );
    }
    const graphExpansion = await measureAiChatPhase(
      input.debugTiming,
      'retrieval.graph_expansion',
      () =>
        this.expandGraph({
          workspaceId: input.workspaceId,
          userId: input.userId,
          supplementalUserId: input.supplementalUserId,
          readableSpaceIds,
          principals,
          ...(graphExpansionMode === 'edge_anchored'
            ? {
                expandablePageIds: strongSeedPageIds(
                  rankedCandidates,
                  authorizedChunkIds,
                ),
              }
            : {}),
          seeds: unique(authorizedChunks.map((candidate) => candidate.page.id))
            .map((knowledgePageId) => ({
              knowledgePageId,
              weight: seedWeightByPageId.get(knowledgePageId) ?? 0,
            }))
            .sort(
              (left, right) =>
                right.weight - left.weight ||
                left.knowledgePageId.localeCompare(right.knowledgePageId),
            ),
          candidateLimit,
          query: input.query,
          ...(queryEmbedding ? { queryEmbedding } : {}),
          authorizationMode: accessPolicyFallbackUsed
            ? 'final-authorization-fallback'
            : 'policy',
          authCache,
          mode: graphExpansionMode,
          ...(input.labelNames?.length ? { labelNames: input.labelNames } : {}),
        }),
      (result) => ({
        graphExpansionMode,
        graphSeedsExpanded: result.seedsExpanded,
        graphWindowPageCount: result.windowPageIds.length,
        graphCandidateCount: graphCandidateIds(result).size,
      }),
    );
    const graphCandidateCount = graphCandidateIds(graphExpansion).size;

    let selectedChunks = authorizedChunks.slice(0, candidateLimit);
    let gatedGraphCandidateCount = 0;
    const graphMaxCosineDistance =
      graphExpansionMode === 'edge_anchored'
        ? maxCosineDistance + EDGE_ANCHORED_DISTANCE_SLACK
        : maxCosineDistance;
    if (graphCandidateCount > 0 && graphExpansionMode === 'edge_anchored') {
      const anchoredStartedAt = performance.now();
      const directSelectedChunkIds = new Set(
        selectedChunks.map((candidate) => candidate.chunk.id),
      );
      const anchored = selectEdgeAnchoredCandidates({
        ranker: this.ranker,
        graph: graphExpansion,
        excludeChunkIds: directSelectedChunkIds,
        maxCosineDistance: graphMaxCosineDistance,
      });
      for (const candidate of anchored) {
        relevantChunkIds.add(candidate.chunk.id);
      }
      gatedGraphCandidateCount = graphCandidateCount - anchored.length;
      input.debugTiming?.record(
        'retrieval.rank_candidates',
        performance.now() - anchoredStartedAt,
        { rankedCandidateCount: anchored.length, pass: 'graph-anchored' },
      );

      if (anchored.length > 0) {
        const anchoredSourceRows = await measureAiChatPhase(
          input.debugTiming,
          'retrieval.load_graph_chunk_sources',
          () =>
            this.capsuleRepo.findChunkSourcePageIdsByChunkIds({
              workspaceId: input.workspaceId,
              chunkIds: anchored.map((candidate) => candidate.chunk.id),
            }),
          (result) => ({ sourceRowCount: result.length }),
        );
        const anchoredReadableSourcePageIds = await measureAiChatPhase(
          input.debugTiming,
          'retrieval.authorize_graph_sources',
          () =>
            this.sourceAuthorization.filterReadableSources({
              workspaceId: input.workspaceId,
              userId: input.userId,
              supplementalUserId: input.supplementalUserId,
              sourcePageIds: unique(
                anchoredSourceRows.flatMap((row) => row.sourcePageIds),
              ),
              cache: authCache,
            }),
          (result) => ({ readableSourceCount: result.length }),
        );
        const authorizedAnchored = authorizeRanked(
          anchored,
          new Map(
            anchoredSourceRows.map((row) => [row.chunkId, row.sourcePageIds]),
          ),
          new Set(anchoredReadableSourcePageIds),
        ).map((candidate) => ({ ...candidate, origin: 'graph' as const }));
        for (const candidate of authorizedAnchored) {
          authorizedChunkIds.add(candidate.chunk.id);
        }
        selectedChunks = mergeAnchoredGraphCandidates({
          directBaseline: authorizedChunks,
          graph: authorizedAnchored,
          limit: candidateLimit,
        });
      }
    } else if (graphCandidateCount > 0) {
      const fusedStartedAt = performance.now();
      let fusedCandidates = filterRelevantCandidates(
        rankRecallCandidates(selectedRecall, {
          dense: graphExpansion.dense,
          lexical: graphExpansion.lexical,
        }),
      );
      for (const candidate of fusedCandidates) {
        relevantChunkIds.add(candidate.chunk.id);
      }
      gatedGraphCandidateCount =
        graphCandidateCount -
        fusedCandidates.filter((candidate) =>
          candidate.signals.includes('graph'),
        ).length;
      input.debugTiming?.record(
        'retrieval.rank_candidates',
        performance.now() - fusedStartedAt,
        {
          rankedCandidateCount: fusedCandidates.length,
          pass: 'graph-fused',
        },
      );

      const fusedSourceRows = await measureAiChatPhase(
        input.debugTiming,
        'retrieval.load_graph_chunk_sources',
        () =>
          this.capsuleRepo.findChunkSourcePageIdsByChunkIds({
            workspaceId: input.workspaceId,
            chunkIds: fusedCandidates.map((candidate) => candidate.chunk.id),
          }),
        (result) => ({ sourceRowCount: result.length }),
      );
      const fusedSourcesByChunkId = new Map(
        fusedSourceRows.map((row) => [row.chunkId, row.sourcePageIds]),
      );
      const fusedReadableSourcePageIds = await measureAiChatPhase(
        input.debugTiming,
        'retrieval.authorize_graph_sources',
        () =>
          this.sourceAuthorization.filterReadableSources({
            workspaceId: input.workspaceId,
            userId: input.userId,
            supplementalUserId: input.supplementalUserId,
            sourcePageIds: unique(
              fusedSourceRows.flatMap((row) => row.sourcePageIds),
            ),
            cache: authCache,
          }),
        (result) => ({ readableSourceCount: result.length }),
      );
      const authorizedFusedChunks = authorizeRanked(
        fusedCandidates,
        fusedSourcesByChunkId,
        new Set(fusedReadableSourcePageIds),
      );
      for (const candidate of authorizedFusedChunks) {
        authorizedChunkIds.add(candidate.chunk.id);
      }
      selectedChunks = selectBoundedGraphCandidates({
        fused: authorizedFusedChunks,
        directBaseline: authorizedChunks,
        limit: candidateLimit,
      });
    }
    const finalAuthorizedSourceCount = unique(
      selectedChunks.flatMap((candidate) => candidate.sourcePageIds),
    ).length;
    // Direct hits that survived blending, in their final rank order. Graph-only
    // chunks never contribute attachments (§7.1 / §1.2).
    const directHitChunkIds = selectedChunks
      .filter((candidate) => candidate.origin === 'direct')
      .map((candidate) => candidate.chunk.id);

    const observationCandidates = toRawRetrievalCandidates({
      policyRecall,
      fallbackRecall,
      topK: candidateLimit,
      graph: graphExpansion,
      graphAuthorizationMode: accessPolicyFallbackUsed ? 'fallback' : 'policy',
    });
    const retrievalObservationDrops = buildRetrievalDrops({
      candidates: observationCandidates,
      selectedChunkIds: new Set(
        selectedChunks.map((candidate) => candidate.chunk.id),
      ),
      relevantChunkIds,
      authorizedChunkIds,
      threshold: maxCosineDistance,
      graphThreshold: graphMaxCosineDistance,
    });

    const disclosedChunks = await measureAiChatPhase(
      input.debugTiming,
      'retrieval.redact_page_metadata',
      () =>
        this.redactUnreadablePageMetadata({
          workspaceId: input.workspaceId,
          userId: input.userId,
          supplementalUserId: input.supplementalUserId,
          chunks: selectedChunks,
          authCache,
        }),
      (result) => ({
        redactedChunkCount: result.filter(
          (candidate, index) => candidate.page !== selectedChunks[index].page,
        ).length,
      }),
    );

    return {
      mode: accessPolicyFallbackUsed
        ? 'high_completeness_fallback'
        : 'high_completeness',
      chunks: disclosedChunks,
      capsules: [],
      directHitChunkIds,
      retrievalObservation: {
        attempted: true,
        candidates: observationCandidates,
        dropped: retrievalObservationDrops,
        topK: candidateLimit,
        threshold:
          input.maxCosineDistance ?? DEFAULT_MAX_RELEVANT_COSINE_DISTANCE,
      },
      completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
      scope: {
        requestedSpaceIds,
        effectiveSpaceIds: readableSpaceIds,
      },
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
        rankedCandidateCount: rankedCandidates.length + graphCandidateCount,
        authorizedChunkCount: selectedChunks.length,
        filteredChunkCount:
          rankedCandidates.length + graphCandidateCount - selectedChunks.length,
        graph: {
          expansionMode: graphExpansionMode,
          candidateCount: graphCandidateCount,
          gatedOutCount: gatedGraphCandidateCount,
          selectedCount: selectedChunks.filter(
            (candidate) => candidate.origin === 'graph',
          ).length,
          expandedSeedCount: graphExpansion.seedsExpanded,
          edgeCounts: graphExpansion.edgesByType,
          pageCountsByHop: graphExpansion.pagesByHop,
        },
      },
    };
  }

  /**
   * A chunk is authorized by its own sources, but its knowledge page's title,
   * canonicalKey, summary and body are merged from every source of the page.
   * When the reader cannot read all page sources, return a page copy with that
   * concept-level metadata removed: the title becomes the title the chunk's own
   * (authorized) source gave its contribution, and canonicalKey/summary/body
   * are cleared. The artifact id stays as a non-semantic identifier.
   */
  private async redactUnreadablePageMetadata(input: {
    workspaceId: string;
    userId: string;
    supplementalUserId?: string;
    chunks: KnowledgeRetrievalResult['chunks'];
    authCache: KnowledgeAuthorizationCache;
  }): Promise<KnowledgeRetrievalResult['chunks']> {
    if (input.chunks.length === 0) return input.chunks;
    // Compatibility for injected test repos that predate page-level metadata
    // authorization. The production repo always implements it.
    if (typeof this.capsuleRepo.findPageSourcePageIdsByPageIds !== 'function') {
      return input.chunks;
    }
    const pageIds = unique(input.chunks.map((candidate) => candidate.page.id));
    const pageSources = await this.capsuleRepo.findPageSourcePageIdsByPageIds({
      workspaceId: input.workspaceId,
      knowledgePageIds: pageIds,
    });
    const readable = new Set(
      await this.sourceAuthorization.filterReadableSources({
        workspaceId: input.workspaceId,
        userId: input.userId,
        supplementalUserId: input.supplementalUserId,
        sourcePageIds: unique([...pageSources.values()].flat()),
        cache: input.authCache,
      }),
    );
    const restricted = input.chunks.filter((candidate) => {
      const sources = pageSources.get(candidate.page.id) ?? [];
      return (
        sources.length === 0 ||
        !sources.every((sourcePageId) => readable.has(sourcePageId))
      );
    });
    if (restricted.length === 0) return input.chunks;

    const titleRows = this.contributionRepo
      ? await this.contributionRepo.findContributionTitles({
          workspaceId: input.workspaceId,
          pairs: restricted.flatMap((candidate) =>
            candidate.sourcePageIds.map((sourcePageId) => ({
              artifactId: candidate.page.id,
              sourcePageId,
            })),
          ),
        })
      : [];
    const titleByPair = new Map(
      titleRows
        .filter((row) => row.title)
        .map((row) => [`${row.artifactId}:${row.sourcePageId}`, row.title!]),
    );
    const restrictedSet = new Set(restricted);
    return input.chunks.map((candidate) => {
      if (!restrictedSet.has(candidate)) return candidate;
      const title =
        candidate.sourcePageIds
          .map((sourcePageId) =>
            titleByPair.get(`${candidate.page.id}:${sourcePageId}`),
          )
          .find(Boolean) ?? 'Untitled';
      return {
        ...candidate,
        page: {
          ...candidate.page,
          title,
          canonicalKey: null,
          summary: null,
          body: '',
        },
      };
    });
  }

  private async expandGraph(input: {
    workspaceId: string;
    userId: string;
    supplementalUserId?: string;
    readableSpaceIds: string[];
    principals: Array<{
      principalType: 'user' | 'group';
      principalId: string;
    }>;
    seeds: KnowledgeGraphTraversalSeed[];
    candidateLimit: number;
    query: string;
    queryEmbedding?: {
      vector: number[];
      profile: string;
      model: string;
      dimensions: number;
    };
    authorizationMode: 'policy' | 'final-authorization-fallback';
    authCache: KnowledgeAuthorizationCache;
    mode?: KnowledgeGraphExpansionMode;
    /**
     * When set, only these seed pages may be expanded. All seeds still count as
     * visited so a weak direct page is never re-added as its own neighbor.
     */
    expandablePageIds?: Set<string>;
    labelNames?: string[];
  }): Promise<GraphExpansionResult> {
    const empty: GraphExpansionResult = {
      dense: [],
      lexical: [],
      windowPageIds: [],
      anchorScoreByPageId: new Map(),
      seedsExpanded: 0,
      seedsSkippedByThreshold: 0,
      edgesScanned: 0,
      edgesAuthorized: 0,
      edgesByType: { link: 0, 'shared-source': 0 },
      pagesByHop: {},
    };
    if (input.seeds.length === 0 || input.candidateLimit <= 1) return empty;

    const topWeight = input.seeds[0]?.weight ?? 0;
    const weightThreshold = topWeight * GRAPH_SEED_WEIGHT_RATIO;
    const eligibleSeeds = input.seeds
      .filter((seed) => seed.weight >= weightThreshold)
      .filter(
        (seed) =>
          !input.expandablePageIds ||
          input.expandablePageIds.has(seed.knowledgePageId),
      )
      .slice(0, GRAPH_SEED_LIMIT);
    if (eligibleSeeds.length === 0) return empty;
    const seedsSkippedByThreshold = input.seeds.length - eligibleSeeds.length;

    const visited = new Set(input.seeds.map((seed) => seed.knowledgePageId));
    const hopByPageId = new Map<string, number>();
    const typeWeightByPageId = new Map<string, number>();
    // Strongest (relative seed weight × edge type weight) path into a neighbor;
    // edge_anchored mode ranks graph candidates by it instead of similarity.
    const anchorScoreByPageId = new Map<string, number>();
    const seedWeightById = new Map(
      eligibleSeeds.map((seed) => [seed.knowledgePageId, seed.weight]),
    );
    const edgesByType: Record<KnowledgeGraphEdgeType, number> = {
      link: 0,
      'shared-source': 0,
    };
    let frontier = eligibleSeeds;
    let edgesScanned = 0;
    let edgesAuthorized = 0;
    const edgeLimit = Math.max(input.candidateLimit * 20, 100);

    for (let hop = 1; hop <= 1 && frontier.length > 0; hop += 1) {
      const frontierPageIds = frontier.map((seed) => seed.knowledgePageId);
      const frontierSourceIds =
        await this.capsuleRepo.findGraphFrontierSourceIds({
          workspaceId: input.workspaceId,
          spaceIds: input.readableSpaceIds,
          knowledgePageIds: frontierPageIds,
        });
      edgesScanned += frontierSourceIds.length;
      if (frontierSourceIds.length === 0) break;
      const readableSourcePageIds =
        await this.sourceAuthorization.filterReadableSources({
          workspaceId: input.workspaceId,
          userId: input.userId,
          supplementalUserId: input.supplementalUserId,
          sourcePageIds: frontierSourceIds,
          cache: input.authCache,
        });
      const edges = await this.capsuleRepo.findGraphTraversalEdges({
        workspaceId: input.workspaceId,
        spaceIds: input.readableSpaceIds,
        seeds: frontier,
        readableSourcePageIds,
        limit: edgeLimit,
      });
      if (edges.length === 0) break;
      edgesAuthorized += edges.length;

      const frontierSet = new Set(frontierPageIds);
      const nextFrontier = new Map<string, number>();
      for (const edge of edges) {
        edgesByType[edge.type] += 1;
        if (edge.sourcePageIds.length === 0) continue;
        for (const [currentPageId, neighborPageId] of edgeDirections(edge)) {
          if (!frontierSet.has(currentPageId) || visited.has(neighborPageId)) {
            continue;
          }
          nextFrontier.set(
            neighborPageId,
            Math.max(nextFrontier.get(neighborPageId) ?? 0, edge.weight),
          );
          hopByPageId.set(neighborPageId, hop);
          typeWeightByPageId.set(
            neighborPageId,
            Math.max(typeWeightByPageId.get(neighborPageId) ?? 0, edge.weight),
          );
          const relativeSeedWeight =
            topWeight > 0
              ? (seedWeightById.get(currentPageId) ?? 0) / topWeight
              : 0;
          anchorScoreByPageId.set(
            neighborPageId,
            Math.max(
              anchorScoreByPageId.get(neighborPageId) ?? 0,
              relativeSeedWeight * edge.weight,
            ),
          );
        }
      }
      frontier = [...nextFrontier].map(([knowledgePageId, weight]) => ({
        knowledgePageId,
        weight,
      }));
      for (const seed of frontier) visited.add(seed.knowledgePageId);
    }

    const pagesByHop: Record<number, number> = {};
    for (const hop of hopByPageId.values()) {
      pagesByHop[hop] = (pagesByHop[hop] ?? 0) + 1;
    }
    const windowPageIds = [...hopByPageId.keys()]
      .sort((left, right) => {
        const hopDifference =
          (hopByPageId.get(left) ?? 3) - (hopByPageId.get(right) ?? 3);
        if (hopDifference !== 0) return hopDifference;
        const weightDifference =
          (typeWeightByPageId.get(right) ?? 0) -
          (typeWeightByPageId.get(left) ?? 0);
        return weightDifference || left.localeCompare(right);
      })
      .slice(0, graphWindowPageLimit(input.candidateLimit));
    if (windowPageIds.length === 0) {
      return {
        ...empty,
        seedsExpanded: eligibleSeeds.length,
        seedsSkippedByThreshold,
        edgesScanned,
        edgesAuthorized,
        edgesByType,
      };
    }

    const windowScope = {
      workspaceId: input.workspaceId,
      spaceIds: input.readableSpaceIds,
      principals: input.principals,
      knowledgePageIds: windowPageIds,
      authorizationMode: input.authorizationMode,
      // edge_anchored needs a best chunk per neighbor page, not just the
      // globally nearest few, so the window recall must cover every page.
      limit:
        input.mode === 'edge_anchored'
          ? Math.max(
              windowPageIds.length * EDGE_ANCHORED_CHUNKS_PER_PAGE_RECALL,
              input.candidateLimit * 2,
            )
          : Math.max(input.candidateLimit * 2, input.candidateLimit),
      ...(input.labelNames?.length ? { labelNames: input.labelNames } : {}),
    };
    const [denseWindow, lexicalWindow] = await Promise.all([
      input.queryEmbedding
        ? this.capsuleRepo.findDenseChunkCandidates({
            ...windowScope,
            embedding: input.queryEmbedding,
          })
        : Promise.resolve([]),
      this.capsuleRepo.findLexicalChunkCandidates({
        ...windowScope,
        query: input.query,
      }),
    ]);

    const withGraphSignal = (candidate: KnowledgeChunkCandidate) => ({
      ...candidate,
      signals: unique([
        ...candidate.signals,
        'graph',
      ]) as KnowledgeRetrievalSignal[],
    });

    return {
      dense: denseWindow.map(withGraphSignal),
      lexical: lexicalWindow.map(withGraphSignal),
      windowPageIds,
      anchorScoreByPageId: new Map(
        windowPageIds.map((pageId) => [
          pageId,
          anchorScoreByPageId.get(pageId) ?? 0,
        ]),
      ),
      seedsExpanded: eligibleSeeds.length,
      seedsSkippedByThreshold,
      edgesScanned,
      edgesAuthorized,
      edgesByType,
      pagesByHop,
    };
  }
}

function graphCandidateIds(graph: {
  dense: KnowledgeChunkCandidate[];
  lexical: KnowledgeChunkCandidate[];
}): Set<string> {
  return new Set(
    [...graph.dense, ...graph.lexical].map((candidate) => candidate.chunk.id),
  );
}

const GRAPH_SEED_LIMIT = 3;
const GRAPH_SEED_WEIGHT_RATIO = 0.5;
function graphWindowPageLimit(candidateLimit: number): number {
  return Math.max(candidateLimit * 4, 32);
}

/**
 * edge_anchored relaxes the semantic gate for graph neighbors by this much:
 * the edge already establishes that the page is related, so the gate only has
 * to reject chunks that are plainly off-topic. Real audits show neighbor chunks
 * sit at a median cosine distance of ~0.62 vs ~0.55 for direct candidates.
 */
const EDGE_ANCHORED_DISTANCE_SLACK = 0.1;
const EDGE_ANCHORED_CHUNKS_PER_PAGE = 1;
/**
 * A seed page is only expanded when one of its authorized direct hits is
 * strong on its own: an exact-title match or a close semantic match. Seed
 * weights are relative (RRF), so without this floor a barely relevant top hit
 * still expands at full strength and drags in its neighborhood.
 */
const EDGE_ANCHORED_STRONG_SEED_MAX_DISTANCE = 0.4;

function strongSeedPageIds(
  candidates: KnowledgeRankedChunkCandidate[],
  authorizedChunkIds: Set<string>,
): Set<string> {
  const pageIds = new Set<string>();
  for (const candidate of candidates) {
    if (!authorizedChunkIds.has(candidate.chunk.id)) continue;
    const distance = candidate.signalScores.semantic;
    if (
      candidate.signals.includes('exact-title') ||
      (distance !== undefined &&
        distance <= EDGE_ANCHORED_STRONG_SEED_MAX_DISTANCE)
    ) {
      pageIds.add(candidate.page.id);
    }
  }
  return pageIds;
}
const EDGE_ANCHORED_CHUNKS_PER_PAGE_RECALL = 2;

/**
 * Turns graph window recall into edge-anchored candidates: chunks already
 * selected as direct hits are skipped, each neighbor keeps only its best
 * chunk(s) that clear the relaxed gate, and pages are ordered by the edge
 * anchor score (seed strength × edge type weight) before query similarity.
 */
function selectEdgeAnchoredCandidates(input: {
  ranker: KnowledgeRetrievalRankerService;
  graph: GraphExpansionResult;
  excludeChunkIds: Set<string>;
  maxCosineDistance: number;
}): KnowledgeRankedChunkCandidate[] {
  const fused = input.ranker
    .fuseRecallLists({
      recallLists: [
        { signal: 'semantic', candidates: input.graph.dense },
        { signal: 'lexical', candidates: input.graph.lexical },
      ],
      limit: input.graph.dense.length + input.graph.lexical.length,
    })
    .filter(
      (candidate) =>
        !input.excludeChunkIds.has(candidate.chunk.id) &&
        input.ranker.isCandidateRelevant({
          candidate,
          maxCosineDistance: input.maxCosineDistance,
        }),
    );

  const keptPerPage = new Map<string, number>();
  const kept: KnowledgeRankedChunkCandidate[] = [];
  for (const candidate of fused) {
    const pageId = candidate.page.id;
    const count = keptPerPage.get(pageId) ?? 0;
    if (count >= EDGE_ANCHORED_CHUNKS_PER_PAGE) continue;
    keptPerPage.set(pageId, count + 1);
    kept.push(candidate);
  }

  const anchorOf = (candidate: KnowledgeRankedChunkCandidate) =>
    input.graph.anchorScoreByPageId.get(candidate.page.id) ?? 0;
  return kept.sort(
    (left, right) =>
      anchorOf(right) - anchorOf(left) ||
      right.score - left.score ||
      left.chunk.id.localeCompare(right.chunk.id),
  );
}

/**
 * Direct hits keep their rank and fill the head of the result; graph hits take
 * a reserved tail slice instead of competing with direct hits on similarity.
 * When direct recall is sparse, graph hits may fill the remaining slots.
 */
function mergeAnchoredGraphCandidates(input: {
  directBaseline: KnowledgeRetrievalResult['chunks'];
  graph: KnowledgeRetrievalResult['chunks'];
  limit: number;
}): KnowledgeRetrievalResult['chunks'] {
  if (input.limit <= 0) return [];
  const graphReserve = Math.max(1, Math.floor(input.limit / 4));
  const directSlots = Math.max(
    input.limit - Math.min(graphReserve, input.graph.length),
    0,
  );
  const direct = input.directBaseline.slice(0, directSlots);
  const directChunkIds = new Set(direct.map((candidate) => candidate.chunk.id));
  const graph = input.graph
    .filter((candidate) => !directChunkIds.has(candidate.chunk.id))
    .slice(0, input.limit - direct.length);
  return [...direct, ...graph];
}

type GraphExpansionResult = {
  dense: KnowledgeChunkCandidate[];
  lexical: KnowledgeChunkCandidate[];
  windowPageIds: string[];
  anchorScoreByPageId: Map<string, number>;
  seedsExpanded: number;
  seedsSkippedByThreshold: number;
  edgesScanned: number;
  edgesAuthorized: number;
  edgesByType: Record<KnowledgeGraphEdgeType, number>;
  pagesByHop: Record<number, number>;
};

function emptyResult(input: {
  scope: KnowledgeRetrievalScope;
  diagnostics?: Partial<KnowledgeRetrievalDiagnostics>;
  mode?: KnowledgeRetrievalResult['mode'];
  retrievalObservation?: KnowledgeRetrievalObservation;
}): KnowledgeRetrievalResult {
  return {
    mode: input.mode ?? 'high_completeness',
    chunks: [],
    capsules: [],
    directHitChunkIds: [],
    retrievalObservation: input.retrievalObservation ?? {
      attempted: false,
      candidates: [],
      dropped: [],
      topK: 20,
      threshold: DEFAULT_MAX_RELEVANT_COSINE_DISTANCE,
    },
    completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
    scope: input.scope,
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
      graph: {
        candidateCount: 0,
        gatedOutCount: 0,
        selectedCount: 0,
        expandedSeedCount: 0,
        edgeCounts: { link: 0, 'shared-source': 0 },
        pageCountsByHop: {},
      },
      ...input.diagnostics,
    },
  };
}

function toRawRetrievalCandidates(input: {
  policyRecall: RecallShape;
  fallbackRecall?: RecallShape | null;
  topK: number;
  graph?: {
    dense: KnowledgeChunkCandidate[];
    lexical: KnowledgeChunkCandidate[];
  };
  graphAuthorizationMode?: 'policy' | 'fallback';
}): KnowledgeRetrievalCandidate[] {
  const recallLists = (
    recall: RecallShape,
    authorizationMode: 'policy' | 'fallback',
  ): KnowledgeRetrievalCandidate[] => {
    const directLists: Array<{
      signal: 'semantic' | 'lexical' | 'exact-title';
      candidates: KnowledgeChunkCandidate[];
    }> = [
      { signal: 'semantic', candidates: recall[0][0] },
      { signal: 'lexical', candidates: recall[0][1] },
      { signal: 'exact-title', candidates: recall[0][2] },
      { signal: 'semantic', candidates: recall[1][0] },
      { signal: 'lexical', candidates: recall[1][1] },
      { signal: 'exact-title', candidates: recall[1][2] },
    ];
    return directLists.flatMap(({ signal, candidates: list }) =>
      list.slice(0, input.topK).map((candidate) => ({
        pageId: candidate.page.id,
        chunkId: candidate.chunk.id,
        score: rawCandidateScore(candidate, signal),
        scoreType: rawCandidateScoreType(signal),
        reasons: rankReasonsForRawCandidate(signal),
        stage: 'direct' as const,
        authorizationMode,
      })),
    );
  };
  const candidates = [
    ...recallLists(input.policyRecall, 'policy'),
    ...(input.fallbackRecall
      ? recallLists(input.fallbackRecall, 'fallback')
      : []),
  ];
  if (!input.graph) return candidates;
  const graphLists: Array<{
    signal: 'semantic' | 'lexical' | 'exact-title';
    candidates: KnowledgeChunkCandidate[];
  }> = [
    { signal: 'semantic', candidates: input.graph.dense },
    { signal: 'lexical', candidates: input.graph.lexical },
  ];
  return [
    ...candidates,
    ...graphLists.flatMap(({ signal, candidates: list }) =>
      list.slice(0, input.topK).map((candidate) => ({
        pageId: candidate.page.id,
        chunkId: candidate.chunk.id,
        score: rawCandidateScore(candidate, signal),
        scoreType: rawCandidateScoreType(signal),
        reasons: rankReasonsForRawCandidate(signal),
        stage: 'graph' as const,
        authorizationMode: input.graphAuthorizationMode ?? 'policy',
      })),
    ),
  ];
}

type RecallShape = [
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
];

function rawCandidateScore(
  candidate: KnowledgeChunkCandidate,
  signal: 'semantic' | 'lexical' | 'exact-title',
): number {
  const score =
    signal === 'lexical'
      ? (candidate.lexicalScore ?? candidate.signalScore)
      : candidate.signalScore;
  return typeof score === 'number' && Number.isFinite(score) ? score : 0;
}

function rawCandidateScoreType(
  signal: 'semantic' | 'lexical' | 'exact-title',
): KnowledgeRetrievalCandidate['scoreType'] {
  return signal === 'semantic'
    ? 'semantic_distance'
    : signal === 'lexical'
      ? 'lexical'
      : 'exact_title';
}

function rankReasonsForRawCandidate(
  signal: 'semantic' | 'lexical' | 'exact-title',
): KnowledgeRetrievalRankReason[] {
  return [signal];
}

function buildRetrievalDrops(input: {
  candidates: KnowledgeRetrievalCandidate[];
  selectedChunkIds: Set<string>;
  relevantChunkIds: Set<string>;
  authorizedChunkIds: Set<string>;
  threshold: number;
  /** Semantic gate applied to graph-stage candidates; defaults to threshold. */
  graphThreshold?: number;
}): KnowledgeRetrievalDrop[] {
  const drops = new Map<string, KnowledgeRetrievalDrop>();
  for (const candidate of input.candidates) {
    if (input.selectedChunkIds.has(candidate.chunkId)) continue;
    const threshold =
      candidate.stage === 'graph'
        ? (input.graphThreshold ?? input.threshold)
        : input.threshold;
    const reason: KnowledgeRetrievalDrop['reason'] =
      candidate.scoreType === 'semantic_distance' && candidate.score > threshold
        ? 'below_threshold'
        : !input.relevantChunkIds.has(candidate.chunkId)
          ? 'filtered'
          : !input.authorizedChunkIds.has(candidate.chunkId)
            ? 'unauthorized'
            : 'rank_limit';
    const key = `${candidate.chunkId}:${candidate.pageId}:${reason}`;
    drops.set(key, {
      pageId: candidate.pageId,
      chunkId: candidate.chunkId,
      reason,
    });
  }
  return [...drops.values()];
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
  graph: {
    dense: KnowledgeChunkCandidate[];
    lexical: KnowledgeChunkCandidate[];
  } = {
    dense: [],
    lexical: [],
  },
) {
  const [evidenceRecall, memoryRecall] = recall;
  const [evidenceDense, evidenceLexical, evidenceTitle] = evidenceRecall;
  const [memoryDense, memoryLexical, memoryTitle] = memoryRecall;
  return ranker.fuseRecallLists({
    recallLists: [
      { signal: 'semantic', candidates: evidenceDense, weight: 1 },
      { signal: 'lexical', candidates: evidenceLexical, weight: 0.8 },
      { signal: 'exact-title', candidates: evidenceTitle, weight: 1.2 },
      { signal: 'semantic', candidates: memoryDense, weight: 1 },
      { signal: 'lexical', candidates: memoryLexical, weight: 0.8 },
      { signal: 'exact-title', candidates: memoryTitle, weight: 1.2 },
      { signal: 'semantic', candidates: graph.dense, weight: 0.85 },
      { signal: 'lexical', candidates: graph.lexical, weight: 0.15 },
    ],
    limit,
  });
}

function selectBoundedGraphCandidates(input: {
  fused: KnowledgeRetrievalResult['chunks'];
  directBaseline: KnowledgeRetrievalResult['chunks'];
  limit: number;
}): KnowledgeRetrievalResult['chunks'] {
  if (input.limit <= 0) return [];
  if (input.directBaseline.length === 0)
    return input.fused.slice(0, input.limit);

  const selected: KnowledgeRetrievalResult['chunks'] = [];
  const selectedChunkIds = new Set<string>();
  const graphLimit = Math.floor(input.limit / 4);
  let graphCount = 0;
  const take = (candidate: KnowledgeRetrievalResult['chunks'][number]) => {
    if (
      selected.length >= input.limit ||
      selectedChunkIds.has(candidate.chunk.id) ||
      (candidate.origin === 'graph' && graphCount >= graphLimit)
    ) {
      return;
    }
    selected.push(candidate);
    selectedChunkIds.add(candidate.chunk.id);
    if (candidate.origin === 'graph') graphCount += 1;
  };

  const exactTitleDirect = input.directBaseline.find((candidate) =>
    candidate.rankReasons.includes('exact-title'),
  );
  if (exactTitleDirect) {
    take(
      input.fused.find(
        (candidate) => candidate.chunk.id === exactTitleDirect.chunk.id,
      ) ?? exactTitleDirect,
    );
  }

  for (const candidate of input.fused) take(candidate);
  for (const candidate of input.directBaseline) take(candidate);
  return selected;
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

function recallCounts(
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
): Record<string, number> {
  const [evidenceRecall, memoryRecall] = recall;
  const [evidenceDense, evidenceLexical, evidenceTitle] = evidenceRecall;
  const [memoryDense, memoryLexical, memoryTitle] = memoryRecall;
  return {
    denseCandidateCount: uniqueCandidateCount([
      ...evidenceDense,
      ...memoryDense,
    ]),
    lexicalCandidateCount: uniqueCandidateCount([
      ...evidenceLexical,
      ...memoryLexical,
    ]),
    titleCandidateCount: uniqueCandidateCount([
      ...evidenceTitle,
      ...memoryTitle,
    ]),
    totalCandidateCount: uniqueCandidateCount(recall.flat(2)),
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

function edgeDirections(
  edge: KnowledgeGraphTraversalEdge,
): Array<[string, string]> {
  return [
    [edge.fromKnowledgePageId, edge.toKnowledgePageId],
    [edge.toKnowledgePageId, edge.fromKnowledgePageId],
  ];
}

function allSourcesReadable(
  sourcePageIds: string[],
  readableSourcePageIds: Set<string>,
): boolean {
  return (
    sourcePageIds.length > 0 &&
    sourcePageIds.every((sourcePageId) =>
      readableSourcePageIds.has(sourcePageId),
    )
  );
}
