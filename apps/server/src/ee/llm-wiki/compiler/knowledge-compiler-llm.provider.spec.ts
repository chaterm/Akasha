import {
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
} from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOllama } from 'ai-sdk-ollama';
import {
  ConfiguredKnowledgeCompilerLlmProvider,
  KnowledgeCompilerLlmError,
} from './knowledge-compiler-llm.provider';

jest.mock('ai', () => ({
  generateText: jest.fn(),
  Output: { json: jest.fn((options) => ({ ...options, type: 'json' })) },
  NoOutputGeneratedError: { isInstance: jest.fn(() => false) },
  NoObjectGeneratedError: { isInstance: jest.fn(() => false) },
}));
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
    (generateText as jest.Mock).mockResolvedValue({
      output: JSON.parse(analysisJson),
    });
    const provider = createProvider({ aiDriver: driver });

    await expect(
      provider.analyze({ system: 'system', prompt: 'prompt' }),
    ).resolves.toMatchObject({ synopsis: 'Summary' });

    expect(modelFactory).toHaveBeenCalledWith('completion-model');
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'compiler-model',
        system: 'system',
        prompt: 'prompt',
        temperature: 0.1,
        output: expect.objectContaining({
          name: 'knowledge_compiler_analysis_v1',
          type: 'json',
        }),
      }),
    );
    expect(Output.json).toHaveBeenCalled();
  });

  it('parses Stage 2 output with the generation schema', async () => {
    (createOpenAI as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockResolvedValue({
      output: JSON.parse(generationJson),
    });

    await expect(
      createProvider({ aiDriver: 'openai' }).generate({
        system: 'system',
        prompt: 'prompt',
      }),
    ).resolves.toMatchObject({
      artifacts: [{ kind: 'source_summary', canonicalKey: 'page-1' }],
    });
  });

  it('uses JSON mode and validates canonical merge output', async () => {
    (createOpenAI as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockResolvedValue({
      output: { title: 'Merged title', markdown: 'Merged body' },
    });

    await expect(
      createProvider({ aiDriver: 'openai' }).completeMerge?.({
        system: 'system',
        prompt: 'prompt',
      }),
    ).resolves.toBe(
      JSON.stringify({ title: 'Merged title', markdown: 'Merged body' }),
    );
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({
          name: 'knowledge_compiler_merge_v1',
        }),
      }),
    );
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
    const structuredOutputError = new Error('private source text and not JSON');
    (
      NoOutputGeneratedError.isInstance as unknown as jest.Mock
    ).mockImplementation((error) => error === structuredOutputError);
    (generateText as jest.Mock).mockRejectedValue(structuredOutputError);

    await expect(
      createProvider({ aiDriver: 'openai' }).analyze({
        system: 'system',
        prompt: 'prompt',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'invalid_output',
        retryable: true,
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

  it('classifies schema validation failures without exposing model output', async () => {
    (createOpenAI as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    const schemaError = new Error('private malformed generation output');
    (
      NoObjectGeneratedError.isInstance as unknown as jest.Mock
    ).mockImplementation((error) => error === schemaError);
    (generateText as jest.Mock).mockRejectedValue(schemaError);

    await expect(
      createProvider({ aiDriver: 'openai' }).generate({
        system: 'system',
        prompt: 'prompt',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'invalid_output',
        retryable: true,
        message: 'Knowledge compiler returned invalid generation output.',
      }),
    );
  });

  it('validates structured JSON against the compiler schema locally', async () => {
    (createOpenAI as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockResolvedValue({
      output: { version: 1 },
    });

    await expect(
      createProvider({ aiDriver: 'openai' }).analyze({
        system: 'system',
        prompt: 'prompt',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'invalid_output',
        retryable: true,
        message: 'Knowledge compiler returned invalid analysis output.',
      }),
    );
  });

  it('normalizes common compatible-model aliases before schema validation', async () => {
    (createOpenAI as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockResolvedValue({
      output: {
        version: 1,
        artifacts: [
          {
            type: 'source-summary',
            canonical_key: 'Source Page 1',
            name: 'Source summary',
            content: 'Grounded summary body.',
            claims: null,
            links: null,
            tags: null,
            ignored_field: true,
          },
        ],
      },
    });

    await expect(
      createProvider({ aiDriver: 'openai' }).generate({
        system: 'system',
        prompt: 'prompt',
      }),
    ).resolves.toEqual({
      version: '1',
      artifacts: [
        {
          kind: 'source_summary',
          canonicalKey: 'source-page-1',
          title: 'Source summary',
          markdown: 'Grounded summary body.',
          claims: [],
          links: [],
          tags: [],
        },
      ],
      compilerRecovery: 'local_repair',
    });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('re-prompts once with validation feedback when local repair is insufficient', async () => {
    (createOpenAI as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { version: 1 } })
      .mockResolvedValueOnce({ output: JSON.parse(analysisJson) });

    await expect(
      createProvider({ aiDriver: 'openai' }).analyze({
        system: 'system',
        prompt: '<output_contract>{"version":"1"}</output_contract>',
      }),
    ).resolves.toMatchObject({ synopsis: 'Summary' });

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        system: expect.stringContaining('repair invalid analysis JSON'),
        prompt: expect.stringContaining('<validation_errors>'),
        output: expect.objectContaining({
          name: 'knowledge_compiler_analysis_v1_repair',
        }),
      }),
    );
  });

  it('publishes a deterministic source summary fallback after generation repair fails', async () => {
    (createOpenAI as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockResolvedValue({ output: { version: 1 } });

    await expect(
      createProvider({ aiDriver: 'openai' }).generate(
        { system: 'system', prompt: 'prompt' },
        {
          canonicalKey: 'source-page-1',
          title: 'Original title',
          markdown: 'Original source body.',
        },
      ),
    ).resolves.toEqual({
      version: '1',
      artifacts: [
        {
          kind: 'source_summary',
          canonicalKey: 'source-page-1',
          title: 'Original title',
          markdown: 'Original source body.',
          claims: [],
          links: [],
          tags: [],
        },
      ],
      compilerRecovery: 'source_summary_fallback',
    });
    expect(generateText).toHaveBeenCalledTimes(2);
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
