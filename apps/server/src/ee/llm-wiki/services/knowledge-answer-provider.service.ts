import { Injectable } from '@nestjs/common';
import { generateText, LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOllama } from 'ai-sdk-ollama';
import { EnvironmentService } from '../../../integrations/environment/environment.service';

export type KnowledgeAnswerProviderInput = {
  query: string;
  context: string;
  chatContext?: string[];
};

export interface KnowledgeAnswerProvider {
  answer(input: KnowledgeAnswerProviderInput): Promise<string>;
}

@Injectable()
export class ConfiguredKnowledgeAnswerProvider implements KnowledgeAnswerProvider {
  constructor(private readonly environmentService: EnvironmentService) {}

  async answer(input: KnowledgeAnswerProviderInput): Promise<string> {
    const driver = this.environmentService.getAiDriver();
    if (!driver || input.context.trim().length === 0) {
      return '';
    }

    const model = this.createModel(driver);
    if (!model) {
      return '';
    }

    const result = await generateText({
      model,
      system: [
        'Use only the provided knowledge context to answer.',
        'If the context is insufficient, say that the available knowledge does not contain enough information.',
        'Each context section may list citation IDs in the form [[cite:sourcePageId]].',
        'When you use information from a section, append the relevant citation marker to that sentence.',
        'Do not invent citation IDs or cite context that you did not use.',
        'Do not mention hidden, denied, filtered, or unavailable documents.',
      ].join(' '),
      prompt: buildPrompt(input),
    });

    return result.text;
  }

  private createModel(driver: string): LanguageModel | undefined {
    const modelName = this.environmentService.getAiChatModel();
    if (!modelName) {
      return undefined;
    }

    switch (driver) {
      case 'openai': {
        return createOpenAI({
          apiKey: this.environmentService.getOpenAiApiKey(),
          baseURL: this.environmentService.getOpenAiApiUrl(),
        })(modelName);
      }
      case 'openai-compatible': {
        return createOpenAICompatible({
          name: 'openai-compatible',
          apiKey: this.environmentService.getOpenAiApiKey(),
          baseURL: this.environmentService.getOpenAiApiUrl(),
        })(modelName);
      }
      case 'gemini': {
        return createGoogleGenerativeAI({
          apiKey: this.environmentService.getGeminiApiKey(),
        })(modelName);
      }
      case 'ollama': {
        return createOllama({
          baseURL: this.environmentService.getOllamaApiUrl(),
        })(modelName);
      }
      default:
        return undefined;
    }
  }
}

function buildPrompt(input: KnowledgeAnswerProviderInput): string {
  return [
    'Conversation context:',
    ...(input.chatContext ?? []),
    '',
    'Knowledge context:',
    input.context,
    '',
    'User question:',
    input.query,
  ].join('\n');
}
