import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { embed, embedMany, EmbeddingModel } from 'ai';
import { createBoundedAbortSignal } from './knowledge-operation-budget';
import { AiModelConfigService } from './ai-model-config.service';
import { createEmbeddingModelFromConfig } from './ai-model-factory';

/**
 * Bailian text-embedding-v4 provider limits:
 * - at most 10 input strings in one request;
 * - at most 8,192 tokens for EACH input string, not for the batch as a whole.
 *
 * Only the item count can be enforced locally. Bailian does not expose the
 * model's tokenizer through its OpenAI-compatible endpoint, so character or
 * byte counts must not be presented as the 8,192-token limit. The provider is
 * authoritative for that per-input token check; its rejection is normalized
 * below to `embedding_input_too_large`.
 */
export const BAILIAN_TEXT_EMBEDDING_V4_MAX_INPUTS_PER_REQUEST = 10;

export const EMBEDDING_PROVIDER_NAME = 'akashaEmbedding';

export type KnowledgeEmbedding = {
  vector: number[];
  profile: string;
  model: string;
  dimensions: number;
  totalTokens?: number;
  durationMs?: number;
};

export type KnowledgeEmbeddingErrorCode =
  | 'embedding_not_configured'
  | 'embedding_rate_limited'
  | 'embedding_timeout'
  | 'embedding_provider_error'
  | 'embedding_invalid_vector'
  | 'embedding_invalid_input'
  | 'embedding_input_too_large';

export class KnowledgeEmbeddingError extends Error {
  constructor(
    readonly code: KnowledgeEmbeddingErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'KnowledgeEmbeddingError';
  }
}

export interface KnowledgeEmbeddingProvider {
  embedQuery(
    query: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<KnowledgeEmbedding | null>;
  embedRequired(
    text: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<KnowledgeEmbedding>;
  embedManyRequired(
    texts: string[],
    options?: { abortSignal?: AbortSignal },
  ): Promise<KnowledgeEmbedding[]>;
}

export function buildKnowledgeEmbeddingProfile(input: {
  driver: string;
  baseUrl?: string | null;
  model: string;
  dimensions: number;
}): string {
  const identity = [
    normalizeIdentityPart(input.driver),
    normalizeBaseUrl(input.baseUrl),
    input.model.trim(),
    String(input.dimensions),
  ].join('|');

  return createHash('sha256').update(identity).digest('hex');
}

@Injectable()
export class ConfiguredKnowledgeEmbeddingProvider implements KnowledgeEmbeddingProvider {
  constructor(private readonly configService: AiModelConfigService) {}

  async embedQuery(
    query: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<KnowledgeEmbedding | null> {
    return this.embedValue(query, false, options);
  }

  async embedRequired(
    text: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<KnowledgeEmbedding> {
    const result = await this.embedValue(text, true, options);
    if (!result) {
      // The required path always throws instead of returning null. This guard
      // keeps the contract explicit if embedValue is changed later.
      throw new KnowledgeEmbeddingError(
        'embedding_provider_error',
        'Knowledge embedding generation failed.',
        true,
      );
    }
    return result;
  }

  async embedManyRequired(
    texts: string[],
    options?: { abortSignal?: AbortSignal },
  ): Promise<KnowledgeEmbedding[]> {
    if (texts.length === 0) return [];
    if (texts.length > BAILIAN_TEXT_EMBEDDING_V4_MAX_INPUTS_PER_REQUEST) {
      throw new KnowledgeEmbeddingError(
        'embedding_invalid_input',
        `Bailian text-embedding-v4 accepts at most ${BAILIAN_TEXT_EMBEDDING_V4_MAX_INPUTS_PER_REQUEST} inputs per request.`,
        false,
      );
    }
    if (texts.some((text) => text.trim().length === 0)) {
      throw new KnowledgeEmbeddingError(
        'embedding_invalid_input',
        'Knowledge chunk is empty and cannot be embedded.',
        false,
      );
    }
    const config = await this.configService.getResolvedConfig('embedding');
    const driver = config.driver;
    const modelName = config.model;
    const model = createEmbeddingModelFromConfig(
      config,
      EMBEDDING_PROVIDER_NAME,
    );
    if (!driver || !modelName || !model) {
      throw new KnowledgeEmbeddingError(
        'embedding_not_configured',
        'Knowledge embedding provider is not configured.',
        false,
      );
    }

    const boundedSignal = createBoundedAbortSignal(
      options?.abortSignal,
      30_000,
    );
    const startedAt = Date.now();
    try {
      // This is provider-level batching, not merely a local concurrency loop.
      // `texts` has already been capped at Bailian's 10-item request limit;
      // embedMany preserves item boundaries and result order, so batching also
      // leaves non-table embedding semantics unchanged.
      const result = await embedMany({
        model,
        values: texts,
        maxParallelCalls: 2,
        abortSignal: boundedSignal.signal,
      });
      if (
        result.embeddings.length !== texts.length ||
        result.embeddings.some(
          (vector) =>
            vector.length === 0 ||
            vector.some((value) => !Number.isFinite(value)),
        )
      ) {
        throw new KnowledgeEmbeddingError(
          'embedding_invalid_vector',
          'Knowledge embedding provider returned an invalid vector.',
          true,
        );
      }

      const batchDurationMs = Math.max(0, Date.now() - startedAt);
      const allocatedTokens = allocateBatchTokens(texts, result.usage?.tokens);
      return result.embeddings.map((vector, index) => ({
        vector,
        profile: buildKnowledgeEmbeddingProfile({
          driver,
          baseUrl: config.baseUrl,
          model: modelName,
          dimensions: vector.length,
        }),
        model: modelName,
        dimensions: vector.length,
        ...(allocatedTokens ? { totalTokens: allocatedTokens[index] } : {}),
        durationMs: batchDurationMs,
      }));
    } catch (error) {
      if (options?.abortSignal?.aborted) {
        throw options.abortSignal.reason ?? error;
      }
      if (error instanceof KnowledgeEmbeddingError) throw error;
      throw classifyRequiredEmbeddingError(error, boundedSignal.signal);
    } finally {
      boundedSignal.dispose();
    }
  }

  private async embedValue(
    text: string,
    required: boolean,
    options?: { abortSignal?: AbortSignal },
  ): Promise<KnowledgeEmbedding | null> {
    const config = await this.configService.getResolvedConfig('embedding');
    const driver = config.driver;
    const modelName = config.model;
    const model = createEmbeddingModelFromConfig(
      config,
      EMBEDDING_PROVIDER_NAME,
    );
    if (text.trim().length === 0) {
      if (required) {
        throw new KnowledgeEmbeddingError(
          'embedding_invalid_input',
          'Knowledge chunk is empty and cannot be embedded.',
          false,
        );
      }
      return null;
    }
    if (!driver || !modelName || !model) {
      if (required) {
        throw new KnowledgeEmbeddingError(
          'embedding_not_configured',
          'Knowledge embedding provider is not configured.',
          false,
        );
      }
      return null;
    }

    const boundedSignal = createBoundedAbortSignal(
      options?.abortSignal,
      30_000,
    );
    const startedAt = Date.now();
    try {
      const result = await embed({
        model,
        value: text,
        abortSignal: boundedSignal.signal,
      });
      const vector = result.embedding;
      if (
        vector.length === 0 ||
        vector.some((value) => !Number.isFinite(value))
      ) {
        if (required) {
          throw new KnowledgeEmbeddingError(
            'embedding_invalid_vector',
            'Knowledge embedding provider returned an invalid vector.',
            true,
          );
        }
        return null;
      }

      return {
        vector,
        profile: buildKnowledgeEmbeddingProfile({
          driver,
          baseUrl: config.baseUrl,
          model: modelName,
          dimensions: vector.length,
        }),
        model: modelName,
        dimensions: vector.length,
        ...(result.usage?.tokens !== undefined
          ? { totalTokens: result.usage.tokens }
          : {}),
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (error) {
      if (options?.abortSignal?.aborted) {
        throw options.abortSignal.reason ?? error;
      }
      if (required) {
        if (error instanceof KnowledgeEmbeddingError) throw error;
        throw classifyRequiredEmbeddingError(error, boundedSignal.signal);
      }
      return null;
    } finally {
      boundedSignal.dispose();
    }
  }
}

function allocateBatchTokens(
  texts: string[],
  totalTokens: number | undefined,
): number[] | undefined {
  if (totalTokens === undefined) return undefined;
  if (texts.length === 0) return [];
  const weights = texts.map((text) => Math.max(1, text.length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const allocated = weights.map((weight) =>
    Math.floor((totalTokens * weight) / totalWeight),
  );
  let remainder =
    totalTokens - allocated.reduce((sum, value) => sum + value, 0);
  for (let index = 0; remainder > 0; index = (index + 1) % allocated.length) {
    allocated[index] += 1;
    remainder -= 1;
  }
  return allocated;
}

function classifyRequiredEmbeddingError(
  error: unknown,
  boundedSignal: AbortSignal,
): KnowledgeEmbeddingError {
  if (boundedSignal.aborted) {
    return new KnowledgeEmbeddingError(
      'embedding_timeout',
      'Knowledge embedding request timed out.',
      true,
      error,
    );
  }

  const status = providerStatus(error);
  if (status === 429) {
    return new KnowledgeEmbeddingError(
      'embedding_rate_limited',
      'Knowledge embedding provider rate limit was reached.',
      true,
      error,
    );
  }
  if (status === 401 || status === 403) {
    return new KnowledgeEmbeddingError(
      'embedding_not_configured',
      'Knowledge embedding provider credentials are invalid.',
      false,
      error,
    );
  }
  if (status === 400 && isInputTooLargeError(error)) {
    return new KnowledgeEmbeddingError(
      'embedding_input_too_large',
      'Knowledge chunk exceeds the embedding provider input limit.',
      false,
      error,
    );
  }
  return new KnowledgeEmbeddingError(
    'embedding_provider_error',
    'Knowledge embedding provider request failed.',
    status === undefined || status >= 500 || status === 408,
    error,
  );
}

function providerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  for (const key of ['statusCode', 'status'] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === 'number') return value;
  }
  const response = (error as Record<string, unknown>).response;
  if (response && typeof response === 'object') {
    const status = (response as Record<string, unknown>).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

function isInputTooLargeError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return /(token|context|input).*(limit|length|large|long|maximum|max|exceed)/i.test(
    message,
  );
}

function normalizeIdentityPart(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeBaseUrl(value?: string | null): string {
  return (value ?? '').trim().replace(/\/+$/, '').toLowerCase();
}
