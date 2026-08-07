import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embed, EmbeddingModel } from 'ai';
import { createOllama } from 'ai-sdk-ollama';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { createBoundedAbortSignal } from './knowledge-operation-budget';

export type KnowledgeEmbedding = {
  vector: number[];
  profile: string;
  model: string;
  dimensions: number;
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
  constructor(private readonly environmentService: EnvironmentService) {}

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

  private async embedValue(
    text: string,
    required: boolean,
    options?: { abortSignal?: AbortSignal },
  ): Promise<KnowledgeEmbedding | null> {
    const driver = this.environmentService.getAiDriver();
    const modelName = this.environmentService.getAiEmbeddingModel();
    const model = this.createEmbeddingModel(driver);
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
          baseUrl: this.embeddingBaseUrl(driver),
          model: modelName,
          dimensions: vector.length,
        }),
        model: modelName,
        dimensions: vector.length,
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

  private createEmbeddingModel(driver?: string): EmbeddingModel | undefined {
    const modelName = this.environmentService.getAiEmbeddingModel();
    if (!driver || !modelName) {
      return undefined;
    }

    switch (driver) {
      case 'openai': {
        return createOpenAI({
          apiKey: this.environmentService.getOpenAiApiKey(),
          baseURL: this.environmentService.getOpenAiApiUrl(),
        }).embeddingModel(modelName);
      }
      case 'openai-compatible': {
        return createOpenAICompatible({
          name: 'openai-compatible',
          apiKey: this.environmentService.getOpenAiApiKey(),
          baseURL: this.environmentService.getOpenAiApiUrl(),
        }).embeddingModel(modelName);
      }
      case 'gemini': {
        return createGoogleGenerativeAI({
          apiKey: this.environmentService.getGeminiApiKey(),
        }).textEmbeddingModel(modelName);
      }
      case 'ollama': {
        return createOllama({
          baseURL: this.environmentService.getOllamaApiUrl(),
        }).textEmbeddingModel(modelName);
      }
      default:
        return undefined;
    }
  }

  private embeddingBaseUrl(driver: string): string | undefined {
    switch (driver) {
      case 'openai':
      case 'openai-compatible':
        return this.environmentService.getOpenAiApiUrl();
      case 'ollama':
        return this.environmentService.getOllamaApiUrl();
      default:
        return undefined;
    }
  }
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
  return /(token|context|input).*(limit|length|large|maximum|max)/i.test(
    message,
  );
}

function normalizeIdentityPart(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeBaseUrl(value?: string | null): string {
  return (value ?? '').trim().replace(/\/+$/, '').toLowerCase();
}
