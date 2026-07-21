import { Injectable } from '@nestjs/common';
import { generateText, LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOllama } from 'ai-sdk-ollama';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  parseSemanticAnalysisJson,
  parseSemanticGenerationJson,
  SemanticAnalysis,
  SemanticCompilerOutputError,
  SemanticGeneration,
} from './semantic-compiler.schema';
import { SemanticCompilerMessages } from './semantic-compiler.prompts';

export type KnowledgeCompilerLlmErrorCode =
  | 'configuration_error'
  | 'invalid_output'
  | 'rate_limited'
  | 'timeout'
  | 'provider_error';

export class KnowledgeCompilerLlmError extends Error {
  constructor(
    readonly code: KnowledgeCompilerLlmErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'KnowledgeCompilerLlmError';
  }
}

export interface KnowledgeCompilerLlmProvider {
  analyze(messages: SemanticCompilerMessages): Promise<SemanticAnalysis>;
  generate(messages: SemanticCompilerMessages): Promise<SemanticGeneration>;
  completeMerge?(messages: SemanticCompilerMessages): Promise<string>;
}

@Injectable()
export class ConfiguredKnowledgeCompilerLlmProvider
  implements KnowledgeCompilerLlmProvider
{
  constructor(private readonly environmentService: EnvironmentService) {}

  async analyze(messages: SemanticCompilerMessages): Promise<SemanticAnalysis> {
    const text = await this.complete(messages);
    try {
      return parseSemanticAnalysisJson(text);
    } catch (error) {
      throw invalidOutputError('analysis', error);
    }
  }

  async generate(
    messages: SemanticCompilerMessages,
  ): Promise<SemanticGeneration> {
    const text = await this.complete(messages);
    try {
      return parseSemanticGenerationJson(text);
    } catch (error) {
      throw invalidOutputError('generation', error);
    }
  }

  async completeMerge(messages: SemanticCompilerMessages): Promise<string> {
    return this.complete(messages);
  }

  private async complete(messages: SemanticCompilerMessages): Promise<string> {
    const model = this.createModel();
    try {
      const result = await generateText({
        model,
        system: messages.system,
        prompt: messages.prompt,
        temperature: 0.1,
      });
      return result.text;
    } catch (error) {
      if (error instanceof KnowledgeCompilerLlmError) throw error;
      throw classifyProviderError(error);
    }
  }

  private createModel(): LanguageModel {
    const driver = this.environmentService.getAiDriver();
    const modelName = this.environmentService.getAiCompletionModel();
    if (!driver || !modelName) {
      throw new KnowledgeCompilerLlmError(
        'configuration_error',
        'Knowledge compiler LLM is not configured.',
        false,
      );
    }

    switch (driver) {
      case 'openai':
        return createOpenAI({
          apiKey: this.environmentService.getOpenAiApiKey(),
          baseURL: this.environmentService.getOpenAiApiUrl(),
        })(modelName);
      case 'openai-compatible':
        return createOpenAICompatible({
          name: 'openai-compatible',
          apiKey: this.environmentService.getOpenAiApiKey(),
          baseURL: this.environmentService.getOpenAiApiUrl(),
        })(modelName);
      case 'gemini':
        return createGoogleGenerativeAI({
          apiKey: this.environmentService.getGeminiApiKey(),
        })(modelName);
      case 'ollama':
        return createOllama({
          baseURL: this.environmentService.getOllamaApiUrl(),
        })(modelName);
      default:
        throw new KnowledgeCompilerLlmError(
          'configuration_error',
          'Knowledge compiler LLM is not configured.',
          false,
        );
    }
  }
}

function invalidOutputError(
  stage: 'analysis' | 'generation',
  error: unknown,
): KnowledgeCompilerLlmError {
  if (error instanceof KnowledgeCompilerLlmError) return error;
  return new KnowledgeCompilerLlmError(
    'invalid_output',
    `Knowledge compiler returned invalid ${stage} output.`,
    false,
    error instanceof SemanticCompilerOutputError ? error : undefined,
  );
}

function classifyProviderError(error: unknown): KnowledgeCompilerLlmError {
  const status = readNumberProperty(error, 'statusCode') ??
    readNumberProperty(error, 'status');
  if (status === 429) {
    return new KnowledgeCompilerLlmError(
      'rate_limited',
      'Knowledge compiler provider rate limit was exceeded.',
      true,
      error,
    );
  }

  const name = readStringProperty(error, 'name');
  const code = readStringProperty(error, 'code');
  if (
    name === 'AbortError' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED'
  ) {
    return new KnowledgeCompilerLlmError(
      'timeout',
      'Knowledge compiler provider timed out.',
      true,
      error,
    );
  }

  return new KnowledgeCompilerLlmError(
    'provider_error',
    'Knowledge compiler provider request failed.',
    status === undefined || status >= 500,
    error,
  );
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' ? property : undefined;
}

function readNumberProperty(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'number' ? property : undefined;
}
