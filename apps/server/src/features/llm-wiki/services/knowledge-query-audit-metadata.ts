import type { KnowledgeQueryAuditMetadata } from '@akasha/db/repos/llm-wiki/knowledge-query-audit.repo';
import type { KnowledgeQueryObservation } from './ai-knowledge-chat.service';
import type { KnowledgeContextObservation } from './ai-knowledge-chat.service';
import type { KnowledgeRetrievalObservation } from './knowledge-retrieval.service';

export type QueryAuditRetrievalDiagnostics = {
  queryEmbeddingAvailable: boolean;
  candidateSourceCount: number;
  policyCandidateSourceCount: number;
  fallbackCandidateSourceCount: number;
  finalAuthorizedSourceCount: number;
  accessPolicyFallbackUsed: boolean;
  candidateChunkCount: number;
  rankedCandidateCount: number;
  authorizedChunkCount: number;
  filteredChunkCount: number;
  graph?: {
    expansionMode?: string;
    candidateCount: number;
    gatedOutCount: number;
    selectedCount: number;
    expandedSeedCount: number;
    edgeCounts: {
      link: number;
      'shared-source': number;
    };
    pageCountsByHop: Record<number, number>;
  };
};

type CommonAuditMetadata = Omit<
  Pick<
    KnowledgeQueryAuditMetadata,
    | 'answerMode'
    | 'decisionReason'
    | 'generalAnswerReason'
    | 'queryEmbeddingAvailable'
    | 'candidateSourceCount'
    | 'policyCandidateSourceCount'
    | 'fallbackCandidateSourceCount'
    | 'finalAuthorizedSourceCount'
    | 'accessPolicyFallbackUsed'
    | 'candidateChunkCount'
    | 'rankedCandidateCount'
    | 'authorizedChunkCount'
    | 'filteredChunkCount'
    | 'graph'
    | 'finalChunkIds'
    | 'finalSourcePageIds'
    | 'rankReasonsByChunk'
    | 'contextItems'
    | 'packContextLength'
    | 'packMaxContextLength'
    | 'answerContextLength'
    | 'answerContextHash'
    | 'retrieval'
    | 'context'
  >,
  'answerMode'
> & {
  answerMode?: KnowledgeQueryAuditMetadata['answerMode'];
};

export function buildKnowledgeQueryAuditMetadata(input: {
  answerMode: 'knowledge' | 'no_match' | 'general';
  queryObservation: KnowledgeQueryObservation;
  retrievalDiagnostics?: QueryAuditRetrievalDiagnostics;
  retrieval?: KnowledgeRetrievalObservation;
  context?: KnowledgeContextObservation;
}): CommonAuditMetadata {
  const diagnostics = input.retrievalDiagnostics;
  const observation = input.queryObservation;
  return {
    ...(input.answerMode ? { answerMode: input.answerMode } : {}),
    queryEmbeddingAvailable: diagnostics?.queryEmbeddingAvailable ?? false,
    candidateSourceCount: diagnostics?.candidateSourceCount ?? 0,
    policyCandidateSourceCount: diagnostics?.policyCandidateSourceCount ?? 0,
    fallbackCandidateSourceCount:
      diagnostics?.fallbackCandidateSourceCount ?? 0,
    finalAuthorizedSourceCount: diagnostics?.finalAuthorizedSourceCount ?? 0,
    accessPolicyFallbackUsed: diagnostics?.accessPolicyFallbackUsed ?? false,
    candidateChunkCount: diagnostics?.candidateChunkCount ?? 0,
    rankedCandidateCount: diagnostics?.rankedCandidateCount ?? 0,
    authorizedChunkCount: diagnostics?.authorizedChunkCount ?? 0,
    filteredChunkCount: diagnostics?.filteredChunkCount ?? 0,
    ...(diagnostics?.graph ? { graph: diagnostics.graph } : {}),
    ...(input.retrieval
      ? {
          retrieval: input.retrieval,
        }
      : {}),
    ...(input.context
      ? {
          context: {
            items: input.context.items.map(
              ({ itemId, pageId, text, tokenCount }) => ({
                itemId,
                pageId,
                text,
                tokenCount,
              }),
            ),
            usedTokens: input.context.usedTokens,
            maxTokens: input.context.maxTokens,
            dropped: input.context.dropped,
          },
        }
      : {}),
    ...(observation
      ? {
          decisionReason: observation.decisionReason,
          ...(observation.generalAnswerReason
            ? { generalAnswerReason: observation.generalAnswerReason }
            : {}),
          finalChunkIds: observation.finalChunkIds,
          finalSourcePageIds: observation.finalSourcePageIds,
          rankReasonsByChunk: observation.rankReasonsByChunk,
          contextItems: observation.contextItems,
          packContextLength: observation.packContextLength,
          packMaxContextLength: observation.packMaxContextLength,
          answerContextLength: observation.answerContextLength,
          answerContextHash: observation.answerContextHash,
        }
      : {}),
  };
}
