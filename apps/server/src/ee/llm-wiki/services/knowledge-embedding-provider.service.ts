import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embed, EmbeddingModel } from 'ai';
import { createOllama } from 'ai-sdk-ollama';
import { EnvironmentService } from '../../../integrations/environment/environment.service';

export type KnowledgeEmbedding = {
  vector: number[];
  profile: string;
  model: string;
  dimensions: number;
};

export interface KnowledgeEmbeddingProvider {
  embedQuery(query: string): Promise<KnowledgeEmbedding | null>;
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
export class ConfiguredKnowledgeEmbeddingProvider
  implements KnowledgeEmbeddingProvider
{
  constructor(private readonly environmentService: EnvironmentService) {}

  async embedQuery(query: string): Promise<KnowledgeEmbedding | null> {
    const driver = this.environmentService.getAiDriver();
    const modelName = this.environmentService.getAiEmbeddingModel();
    const model = this.createEmbeddingModel(driver);
    if (!driver || !modelName || !model || query.trim().length === 0) {
      return null;
    }

    try {
      const result = await embed({
        model,
        value: query,
      });
      const vector = result.embedding;
      if (
        vector.length === 0 ||
        vector.some((value) => !Number.isFinite(value))
      ) {
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
    } catch {
      return null;
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

function normalizeIdentityPart(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeBaseUrl(value?: string | null): string {
  return (value ?? '').trim().replace(/\/+$/, '').toLowerCase();
}
