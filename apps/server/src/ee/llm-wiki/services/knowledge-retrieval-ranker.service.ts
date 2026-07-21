import { Injectable } from '@nestjs/common';
import { KnowledgeChunk } from '@akasha/db/types/entity.types';
import {
  KnowledgeChunkCandidate,
  KnowledgeRetrievalSignal,
} from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';

type RankableChunk = {
  chunk: KnowledgeChunk;
  vector: number[];
  baseScore: number;
};

type RankedChunk = {
  chunk: KnowledgeChunk;
  score: number;
};

export type KnowledgeRetrievalRankReason =
  | 'semantic'
  | 'lexical'
  | 'exact-title'
  | 'sidecar-prefiltered'
  | 'final-authorization-fallback';

export type KnowledgeRankedChunkCandidate = KnowledgeChunkCandidate & {
  score: number;
  rankReasons: KnowledgeRetrievalRankReason[];
};

const BASE_SCORE_WEIGHT = 0.5;
const BM25_K1 = 1.5;
const BM25_B = 0.75;

@Injectable()
export class KnowledgeRetrievalRankerService {
  rankChunks(input: {
    query: string;
    queryEmbedding: number[];
    chunks: KnowledgeChunk[];
    limit: number;
  }): KnowledgeChunk[] {
    return rankAllChunks(input).slice(0, input.limit);
  }

  rankPageIds(input: {
    query: string;
    queryEmbedding: number[];
    chunks: KnowledgeChunk[];
    limit: number;
  }): string[] {
    const ranked = rankAllChunks(input);
    const pageIds: string[] = [];
    const seen = new Set<string>();

    for (const chunk of ranked) {
      const pageId = chunk.knowledgePageId;
      if (seen.has(pageId)) continue;
      seen.add(pageId);
      pageIds.push(pageId);
      if (pageIds.length >= input.limit) break;
    }

    return pageIds;
  }

  rankHybridCandidates(input: {
    query: string;
    queryEmbedding?: number[];
    candidates: KnowledgeChunkCandidate[];
    limit: number;
    rrfK?: number;
  }): KnowledgeRankedChunkCandidate[] {
    const rrfK = input.rrfK ?? 60;
    const scores = new Map<string, number>();
    const candidatesByChunkId = new Map(
      input.candidates.map((candidate) => [candidate.chunk.id, candidate]),
    );

    for (const rankedCandidates of [
      rankSemanticCandidates(input),
      rankLexicalCandidates(input),
      rankExactTitleCandidates(input),
    ]) {
      rankedCandidates.forEach((candidate, index) => {
        scores.set(
          candidate.chunk.id,
          (scores.get(candidate.chunk.id) ?? 0) + 1 / (rrfK + index + 1),
        );
      });
    }

    return [...scores.entries()]
      .map(([chunkId, score]) => ({
        ...candidatesByChunkId.get(chunkId)!,
        score,
        rankReasons: rankReasons(candidatesByChunkId.get(chunkId)!.signals),
      }))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return signalPriority(right.signals) - signalPriority(left.signals);
      })
      .slice(0, input.limit);
  }

  fuseRecallLists(input: {
    recallLists: Array<{
      signal: KnowledgeRetrievalSignal;
      candidates: KnowledgeChunkCandidate[];
    }>;
    limit: number;
    rrfK?: number;
    weights?: Partial<Record<KnowledgeRetrievalSignal, number>>;
  }): KnowledgeRankedChunkCandidate[] {
    const rrfK = input.rrfK ?? 60;
    const scores = new Map<string, number>();
    const merged = new Map<string, KnowledgeChunkCandidate>();

    for (const list of input.recallLists) {
      const weight = input.weights?.[list.signal] ?? 1;
      list.candidates.forEach((candidate, rank) => {
        const chunkId = candidate.chunk.id;
        scores.set(
          chunkId,
          (scores.get(chunkId) ?? 0) + weight / (rrfK + rank + 1),
        );
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
}

function rankSemanticCandidates(input: {
  query: string;
  queryEmbedding?: number[];
  candidates: KnowledgeChunkCandidate[];
}): KnowledgeChunkCandidate[] {
  if (!input.queryEmbedding) return [];

  const rankable = input.candidates.flatMap((candidate) => {
    if (!candidate.signals.includes('semantic')) return [];

    const vector = parseEmbeddingVector(
      candidate.chunk.embeddingLegacy ?? candidate.chunk.embedding,
    );
    if (!vector || vector.length !== input.queryEmbedding!.length) return [];

    return [
      {
        candidate,
        vector,
        baseScore: cosineSimilarity(input.queryEmbedding!, vector),
      },
    ];
  });
  const bm25Ranked = rerankWithBm25(
    input.query,
    rankable.map((item) => ({
      chunk: item.candidate.chunk,
      vector: item.vector,
      baseScore: item.baseScore,
    })),
  );
  const candidatesByChunkId = new Map(
    rankable.map((item) => [item.candidate.chunk.id, item.candidate]),
  );

  return bm25Ranked.flatMap((ranked) => {
    const candidate = candidatesByChunkId.get(ranked.chunk.id);
    return candidate ? [candidate] : [];
  });
}

function rankLexicalCandidates(input: {
  query: string;
  candidates: KnowledgeChunkCandidate[];
}): KnowledgeChunkCandidate[] {
  return input.candidates
    .filter((candidate) => candidate.signals.includes('lexical'))
    .sort((left, right) => {
      const scoreDiff = (right.lexicalScore ?? 0) - (left.lexicalScore ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      return left.chunk.id.localeCompare(right.chunk.id);
    });
}

function rankExactTitleCandidates(input: {
  query: string;
  candidates: KnowledgeChunkCandidate[];
}): KnowledgeChunkCandidate[] {
  return input.candidates
    .filter((candidate) => candidate.signals.includes('exact-title'))
    .sort((left, right) => left.page.title.localeCompare(right.page.title));
}

function rankReasons(
  signals: KnowledgeRetrievalSignal[],
): KnowledgeRankedChunkCandidate['rankReasons'] {
  const reasons: KnowledgeRankedChunkCandidate['rankReasons'] = [];
  for (const signal of ['exact-title', 'semantic', 'lexical'] as const) {
    if (signals.includes(signal)) reasons.push(signal);
  }
  reasons.push('sidecar-prefiltered');
  return reasons;
}

function signalPriority(signals: KnowledgeRetrievalSignal[]): number {
  if (signals.includes('exact-title')) return 3;
  if (signals.includes('semantic')) return 2;
  if (signals.includes('lexical')) return 1;
  return 0;
}

function rankAllChunks(input: {
  query: string;
  queryEmbedding: number[];
  chunks: KnowledgeChunk[];
}): KnowledgeChunk[] {
  const candidates = input.chunks.flatMap((chunk) => {
    const vector = parseEmbeddingVector(
      chunk.embeddingLegacy ?? chunk.embedding,
    );
    if (!vector || vector.length !== input.queryEmbedding.length) return [];
    return [
      {
        chunk,
        vector,
        baseScore: cosineSimilarity(input.queryEmbedding, vector),
      },
    ];
  });

  return rerankWithBm25(input.query, candidates).map((item) => item.chunk);
}

function parseEmbeddingVector(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (
    !value.every((item) => typeof item === 'number' && Number.isFinite(item))
  ) {
    return undefined;
  }
  return value;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    magA += a[index] * a[index];
    magB += b[index] * b[index];
  }

  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueSignals(
  values: KnowledgeRetrievalSignal[],
): KnowledgeRetrievalSignal[] {
  return [...new Set(values)];
}

function rerankWithBm25(
  query: string,
  candidates: RankableChunk[],
): RankedChunk[] {
  if (candidates.length === 0) return [];
  const queryTerms = tokenize(query);

  if (queryTerms.length === 0) {
    return candidates
      .map((candidate) => ({
        chunk: candidate.chunk,
        score: candidate.baseScore,
      }))
      .sort((left, right) => right.score - left.score);
  }

  const docs = candidates.map((candidate) => tokenize(candidate.chunk.text));
  const stats = buildCorpusStats(docs);

  return candidates
    .map((candidate, index) => ({
      chunk: candidate.chunk,
      score:
        bm25Score(queryTerms, docs[index], stats) +
        candidate.baseScore * BASE_SCORE_WEIGHT,
    }))
    .sort((left, right) => right.score - left.score);
}

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const latinTerms = normalized.match(/[a-z0-9]+/g) ?? [];
  const hanChars = normalized.match(/\p{Script=Han}/gu) ?? [];
  const hanBigrams = hanChars.slice(0, -1).map((char, index) => {
    return `${char}${hanChars[index + 1]}`;
  });

  return [...latinTerms, ...hanChars, ...hanBigrams];
}

type CorpusStats = {
  docFreq: Map<string, number>;
  avgDocLen: number;
  totalDocs: number;
};

function buildCorpusStats(docs: string[][]): CorpusStats {
  const docFreq = new Map<string, number>();
  let totalLen = 0;

  for (const tokens of docs) {
    totalLen += tokens.length;
    for (const term of new Set(tokens)) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  return {
    docFreq,
    avgDocLen: docs.length > 0 ? totalLen / docs.length : 0,
    totalDocs: docs.length,
  };
}

function bm25Score(
  queryTerms: string[],
  docTokens: string[],
  stats: CorpusStats,
): number {
  if (docTokens.length === 0 || stats.totalDocs === 0) return 0;

  const termFreq = countTerms(docTokens);
  const lengthRatio = docTokens.length / (stats.avgDocLen || 1);
  let total = 0;

  for (const term of queryTerms) {
    const tf = termFreq.get(term) ?? 0;
    if (tf === 0) continue;

    const idf = idfWeight(stats.docFreq.get(term) ?? 0, stats.totalDocs);
    const numerator = tf * (BM25_K1 + 1);
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * lengthRatio);
    total += idf * (numerator / denominator);
  }

  return total;
}

function idfWeight(docFrequency: number, totalDocs: number): number {
  return Math.log(1 + (totalDocs - docFrequency + 0.5) / (docFrequency + 0.5));
}

function countTerms(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}
