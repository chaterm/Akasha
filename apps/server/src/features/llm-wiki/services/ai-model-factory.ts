import { EmbeddingModel, LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { ResolvedAiModelConfig } from './ai-model-config.service';

/**
 * Builds a Vercel AI SDK language model from a resolved config. Centralizes the
 * driver switch that was previously duplicated across every provider service.
 * Returns undefined when the config is incomplete or the driver is unknown, so
 * each caller can raise its own feature-specific error.
 */
export function createLanguageModelFromConfig(
  config: ResolvedAiModelConfig,
  name: string,
  _options?: { think?: boolean },
): LanguageModel | undefined {
  const driver = config.driver?.trim().toLowerCase();
  const model = config.model?.trim();
  if (!driver || !model) return undefined;

  if (driver !== 'openai-compatible') return undefined;
  return createOpenAICompatible({
    name,
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  })(model);
}

export function createEmbeddingModelFromConfig(
  config: ResolvedAiModelConfig,
  name: string,
): EmbeddingModel | undefined {
  const driver = config.driver?.trim().toLowerCase();
  const model = config.model?.trim();
  if (!driver || !model) return undefined;

  if (driver !== 'openai-compatible') return undefined;
  return createOpenAICompatible({
    name,
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  }).embeddingModel(model);
}
