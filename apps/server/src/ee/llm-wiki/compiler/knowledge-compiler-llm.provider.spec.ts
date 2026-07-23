import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOllama } from 'ai-sdk-ollama';
import {
  ConfiguredKnowledgeCompilerLlmProvider,
  KnowledgeCompilerLlmError,
} from './knowledge-compiler-llm.provider';

jest.mock('ai', () => ({ generateText: jest.fn() }));
jest.mock('@ai-sdk/openai', () => ({ createOpenAI: jest.fn() }));
jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: jest.fn(),
}));
jest.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: jest.fn(),
}));
jest.mock('ai-sdk-ollama', () => ({ createOllama: jest.fn() }));

const analysisJson = JSON.stringify({
  version: '1',
  synopsis: 'Summary',
  language: 'en',
  entities: [],
  concepts: [],
  claims: [],
  relations: [],
  comparisons: [],
  contradictions: [],
});

const generationJson = JSON.stringify({
  version: '1',
  artifacts: [
    {
      kind: 'source_summary',
      canonicalKey: 'page-1',
      title: 'Summary',
      markdown: 'Summary body',
      claims: [],
      links: [],
      tags: [],
    },
  ],
});

describe('ConfiguredKnowledgeCompilerLlmProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['openai', createOpenAI],
    ['openai-compatible', createOpenAICompatible],
    ['gemini', createGoogleGenerativeAI],
    ['ollama', createOllama],
  ])('creates the configured %s completion model', async (driver, factory) => {
    const modelFactory = jest.fn().mockReturnValue('compiler-model');
    (factory as jest.Mock).mockReturnValue(modelFactory);
    (generateText as jest.Mock).mockResolvedValue({ text: analysisJson });
    const provider = createProvider({ aiDriver: driver });

    await expect(
      provider.analyze({ system: 'system', prompt: 'prompt' }),
    ).resolves.toMatchObject({ synopsis: 'Summary' });

    expect(modelFactory).toHaveBeenCalledWith('completion-model');
    expect(generateText).toHaveBeenCalledWith({
      model: 'compiler-model',
      system: 'system',
      prompt: 'prompt',
      temperature: 0.1,
    });
  });

  it('parses Stage 2 output with the generation schema', async () => {
    (createOpenAI as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockResolvedValue({ text: generationJson });

    await expect(
      createProvider({ aiDriver: 'openai' }).generate({
        system: 'system',
        prompt: 'prompt',
      }),
    ).resolves.toMatchObject({
      artifacts: [{ kind: 'source_summary', canonicalKey: 'page-1' }],
    });
  });

  it('fails fast when the compiler model is not configured', async () => {
    const provider = createProvider({
      aiDriver: 'openai',
      completionModel: '',
    });

    await expect(
      provider.analyze({ system: 'system', prompt: 'private source text' }),
    ).rejects.toMatchObject({
      code: 'configuration_error',
      retryable: false,
      message: 'Knowledge compiler LLM is not configured.',
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('classifies invalid model JSON without exposing the model response', async () => {
    (createOpenAI as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockResolvedValue({
      text: 'private source text and not JSON',
    });

    await expect(
      createProvider({ aiDriver: 'openai' }).analyze({
        system: 'system',
        prompt: 'prompt',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'invalid_output',
        retryable: false,
        message: 'Knowledge compiler returned invalid analysis output.',
      }),
    );
  });

  it('classifies provider rate limits as retryable', async () => {
    (createOpenAI as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockRejectedValue(
      Object.assign(new Error('private quota detail'), { statusCode: 429 }),
    );

    await expect(
      createProvider({ aiDriver: 'openai' }).generate({
        system: 'system',
        prompt: 'prompt',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'rate_limited',
        retryable: true,
        message: 'Knowledge compiler provider rate limit was exceeded.',
      }),
    );
  });
});

function createProvider(input: {
  aiDriver: string;
  completionModel?: string;
}): ConfiguredKnowledgeCompilerLlmProvider {
  return new ConfiguredKnowledgeCompilerLlmProvider({
    getAiDriver: jest.fn(() => input.aiDriver),
    getAiCompletionModel: jest.fn(
      () => input.completionModel ?? 'completion-model',
    ),
    getOpenAiApiKey: jest.fn(() => 'openai-key'),
    getOpenAiApiUrl: jest.fn(() => 'https://openai.example/v1'),
    getGeminiApiKey: jest.fn(() => 'gemini-key'),
    getOllamaApiUrl: jest.fn(() => 'http://ollama.example'),
  } as never);
}

void KnowledgeCompilerLlmError;
