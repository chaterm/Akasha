import { Injectable } from '@nestjs/common';
import {
  KnowledgeChunkCandidate,
  KnowledgeRetrievalSignal,
} from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';

/**
 * 只表达匹配方式。检索路径走 KnowledgeRetrievalOrigin，
 * 授权路径走 KnowledgeRetrievalAuthorizationMode。
 */
export type KnowledgeRetrievalRankReason =
  | 'semantic'
  | 'lexical'
  | 'exact-title';

export type KnowledgeRankedChunkCandidate = KnowledgeChunkCandidate & {
  score: number;
  rankReasons: KnowledgeRetrievalRankReason[];
  signalScores: Partial<Record<KnowledgeRetrievalSignal, number>>;
};

export const DEFAULT_MAX_RELEVANT_COSINE_DISTANCE = 0.45;

@Injectable()
export class KnowledgeRetrievalRankerService {
  fuseRecallLists(input: {
    recallLists: Array<{
      signal: KnowledgeRetrievalSignal;
      candidates: KnowledgeChunkCandidate[];
      weight?: number;
    }>;
    limit: number;
    rrfK?: number;
    weights?: Partial<Record<KnowledgeRetrievalSignal, number>>;
  }): KnowledgeRankedChunkCandidate[] {
    const rrfK = input.rrfK ?? 60;
    const scores = new Map<string, number>();
    const merged = new Map<string, KnowledgeChunkCandidate>();
    const signalScoresByChunkId = new Map<
      string,
      Partial<Record<KnowledgeRetrievalSignal, number>>
    >();

    for (const list of input.recallLists) {
      const weight = list.weight ?? input.weights?.[list.signal] ?? 1;
      list.candidates.forEach((candidate, rank) => {
        const chunkId = candidate.chunk.id;
        scores.set(
          chunkId,
          (scores.get(chunkId) ?? 0) + weight / (rrfK + rank + 1),
        );
        if (typeof candidate.signalScore === 'number') {
          signalScoresByChunkId.set(chunkId, {
            ...(signalScoresByChunkId.get(chunkId) ?? {}),
            [list.signal]: candidate.signalScore,
          });
        }
        const previous = merged.get(chunkId);
        merged.set(chunkId, {
          ...(previous ?? candidate),
          sourcePageIds: unique([
            ...(previous?.sourcePageIds ?? []),
            ...candidate.sourcePageIds,
          ]),
          signals: uniqueSignals([
            ...(previous?.signals ?? []),
            list.signal,
            ...candidate.signals,
          ]),
        });
      });
    }

    return [...merged.values()]
      .map((candidate) => ({
        ...candidate,
        score: scores.get(candidate.chunk.id) ?? 0,
        rankReasons: rankReasons(candidate.signals),
        signalScores: signalScoresByChunkId.get(candidate.chunk.id) ?? {},
      }))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        const priority =
          signalPriority(right.signals) - signalPriority(left.signals);
        if (priority !== 0) return priority;
        return left.chunk.id.localeCompare(right.chunk.id);
      })
      .slice(0, input.limit);
  }

  isCandidateRelevant(input: {
    candidate: KnowledgeRankedChunkCandidate;
    /** Maximum semantic cosine distance; defaults to the built-in threshold. */
    maxCosineDistance?: number;
  }): boolean {
    const { candidate } = input;
    if (candidate.signals.includes('exact-title')) return true;
    if (
      candidate.signals.includes('lexical') &&
      (candidate.signalScores.lexical ?? candidate.lexicalScore ?? 0) > 0
    ) {
      return true;
    }
    if (!candidate.signals.includes('semantic')) return false;
    // The semantic distance gate is authoritative: a chunk recalled only by
    // vector similarity must clear maxCosineDistance on its own. Incidental
    // query/text term overlap must not rescue a semantically distant chunk,
    // otherwise an unrelated question that happens to share one token (e.g. a
    // Chinese 2-gram) pulls in off-topic knowledge regardless of the threshold.
    const semanticDistance = candidate.signalScores.semantic;
    const maxCosineDistance =
      input.maxCosineDistance ?? DEFAULT_MAX_RELEVANT_COSINE_DISTANCE;
    return (
      semanticDistance === undefined || semanticDistance <= maxCosineDistance
    );
  }
}

function rankReasons(
  signals: KnowledgeRetrievalSignal[],
): KnowledgeRankedChunkCandidate['rankReasons'] {
  const reasons: KnowledgeRankedChunkCandidate['rankReasons'] = [];
  for (const signal of ['exact-title', 'semantic', 'lexical'] as const) {
    if (signals.includes(signal)) reasons.push(signal);
  }
  return reasons;
}

function signalPriority(signals: KnowledgeRetrievalSignal[]): number {
  if (signals.includes('exact-title')) return 3;
  if (signals.includes('semantic')) return 2;
  if (signals.includes('lexical')) return 1;
  return 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueSignals(
  values: KnowledgeRetrievalSignal[],
): KnowledgeRetrievalSignal[] {
  return [...new Set(values)];
}
