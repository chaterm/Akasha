import { generateText, streamText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOllama } from 'ai-sdk-ollama';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { ConfiguredKnowledgeAnswerProvider } from './knowledge-answer-provider.service';

jest.mock('ai', () => ({
  generateText: jest.fn(),
  streamText: jest.fn(),
}));

jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(),
}));

jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: jest.fn(),
}));

jest.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: jest.fn(),
}));

jest.mock('ai-sdk-ollama', () => ({
  createOllama: jest.fn(),
}));

describe('ConfiguredKnowledgeAnswerProvider', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (generateText as jest.Mock).mockResolvedValue({ text: 'grounded answer' });
  });

  it('uses the OpenAI chat model with grounded knowledge instructions', async () => {
    const openaiProvider = jest.fn().mockReturnValue('openai-model');
    (createOpenAI as jest.Mock).mockReturnValue(openaiProvider);
    const service = createService({
      aiDriver: 'openai',
      aiChatModel: 'gpt-4.1-mini',
      openAiApiKey: 'openai-key',
      openAiApiUrl: 'https://api.openai.test/v1',
    });

    await expect(
      service.answer({
        query: 'How do we use Kafka?',
        context: '# Kafka\nUse Kafka for events.',
        chatContext: ['Earlier turn'],
      }),
    ).resolves.toBe('grounded answer');

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: 'openai-key',
      baseURL: 'https://api.openai.test/v1',
    });
    expect(openaiProvider).toHaveBeenCalledWith('gpt-4.1-mini');
    expect(generateText).toHaveBeenCalledWith({
      model: 'openai-model',
      system: expect.stringContaining(
        'Answer only from the provided knowledge context',
      ),
      prompt: [
        'Conversation context:',
        'Earlier turn',
        '',
        'Knowledge context:',
        '# Kafka\nUse Kafka for events.',
        '',
        'User question:',
        'How do we use Kafka?',
      ].join('\n'),
    });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(
          'When you use facts from the knowledge context, append the relevant citation marker to that sentence.',
        ),
      }),
    );
  });

  it('uses OpenAI-compatible configuration when AI_DRIVER is openai-compatible', async () => {
    const provider = jest.fn().mockReturnValue('compatible-model');
    (createOpenAICompatible as jest.Mock).mockReturnValue(provider);
    const service = createService({
      aiDriver: 'openai-compatible',
      aiChatModel: 'qwen',
      openAiApiKey: 'compatible-key',
      openAiApiUrl: 'https://llm.example/v1',
    });

    await service.answer({ query: 'Q', context: 'Context' });

    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: 'openai-compatible',
      apiKey: 'compatible-key',
      baseURL: 'https://llm.example/v1',
    });
    expect(provider).toHaveBeenCalledWith('qwen');
  });

  it('uses Gemini and Ollama providers from environment settings', async () => {
    const googleProvider = jest.fn().mockReturnValue('gemini-model');
    const ollamaProvider = jest.fn().mockReturnValue('ollama-model');
    (createGoogleGenerativeAI as jest.Mock).mockReturnValue(googleProvider);
    (createOllama as jest.Mock).mockReturnValue(ollamaProvider);

    await createService({
      aiDriver: 'gemini',
      aiChatModel: 'gemini-2.0-flash',
      geminiApiKey: 'gemini-key',
    }).answer({ query: 'Q', context: 'Context' });
    await createService({
      aiDriver: 'ollama',
      aiChatModel: 'llama3.2',
      ollamaApiUrl: 'http://ollama.test',
    }).answer({ query: 'Q', context: 'Context' });

    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({
      apiKey: 'gemini-key',
    });
    expect(googleProvider).toHaveBeenCalledWith('gemini-2.0-flash');
    expect(createOllama).toHaveBeenCalledWith({
      baseURL: 'http://ollama.test',
    });
    expect(ollamaProvider).toHaveBeenCalledWith('llama3.2');
  });

  it('instructs the model not to fill missing evidence with general knowledge', async () => {
    const openaiProvider = jest.fn().mockReturnValue('openai-model');
    (createOpenAI as jest.Mock).mockReturnValue(openaiProvider);

    await expect(
      createService({ aiDriver: 'openai' }).answer({
        query: 'What weekday is today?',
        context: '   ',
      }),
    ).resolves.toBe('grounded answer');

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'openai-model',
        system: expect.stringContaining(
          'Do not use general world knowledge to supply factual claims',
        ),
        prompt: expect.stringContaining(
          'No workspace knowledge context was retrieved.',
        ),
      }),
    );
  });

  it('uses a separate general-knowledge prompt only when explicitly requested', async () => {
    const openaiProvider = jest.fn().mockReturnValue('openai-model');
    (createOpenAI as jest.Mock).mockReturnValue(openaiProvider);

    await expect(
      createService({ aiDriver: 'openai' }).answer({
        query: 'What is the weather generally like in Shanghai in July?',
        context: '',
        mode: 'general',
      }),
    ).resolves.toBe('grounded answer');

    const request = (generateText as jest.Mock).mock.calls[0][0] as {
      system: string;
    };
    expect(request.system).toContain('general model knowledge');
    expect(request.system).toContain('Do not claim that the answer comes from');
    expect(request.system).not.toContain(
      'Answer only from the provided knowledge context',
    );
  });

  it('does not call the model when driver is missing', async () => {
    await expect(
      createService({ aiDriver: undefined }).answer({
        query: 'Q',
        context: 'Context',
      }),
    ).resolves.toBe('');

    expect(generateText).not.toHaveBeenCalled();
  });

  it('rewrites a contextual follow-up into a standalone retrieval query', async () => {
    const openaiProvider = jest.fn().mockReturnValue('openai-model');
    (createOpenAI as jest.Mock).mockReturnValue(openaiProvider);
    (generateText as jest.Mock).mockResolvedValueOnce({
      text: 'Codex 的套餐多少钱',
    });
    const service = createService({ aiDriver: 'openai' });

    const result = await (
      service as unknown as {
        rewriteQuery(input: {
          query: string;
          chatContext: string[];
        }): Promise<string>;
      }
    ).rewriteQuery({
      query: '套餐多少钱',
      chatContext: [
        'user: Codex 开通目前可以看到哪些人已经开通了',
        'assistant: 可以在 Codex 管理页面查看。',
      ],
    });

    expect(result).toBe('Codex 的套餐多少钱');
    const request = (generateText as jest.Mock).mock.calls[0][0] as {
      system: string;
      prompt: string;
    };
    expect(request).toEqual(
      expect.objectContaining({
        model: 'openai-model',
        maxOutputTokens: 256,
        temperature: 0,
        prompt: expect.stringContaining('Current user question:\n套餐多少钱'),
      }),
    );
    expect(request.system).toContain('standalone retrieval query');
    expect(request.system).toContain(
      'Do not add entities, constraints, facts, or time ranges',
    );
    expect(request.system).toContain(
      'If a reference has multiple plausible antecedents',
    );
  });

  it('keeps the original retrieval query when contextual rewriting fails', async () => {
    const openaiProvider = jest.fn().mockReturnValue('openai-model');
    (createOpenAI as jest.Mock).mockReturnValue(openaiProvider);
    (generateText as jest.Mock).mockRejectedValueOnce(new Error('timeout'));
    const service = createService({ aiDriver: 'openai' });

    await expect(
      service.rewriteQuery({
        query: '套餐多少钱',
        chatContext: ['user: Codex 开通'],
      }),
    ).resolves.toBe('套餐多少钱');
  });

  it('uses the configured total input limit only as a large-context safeguard', async () => {
    const openaiProvider = jest.fn().mockReturnValue('openai-model');
    (createOpenAI as jest.Mock).mockReturnValue(openaiProvider);
    const service = createService({
      aiDriver: 'openai',
      aiChatMaxInputChars: 700_000,
    });

    await service.answer({
      query: `CURRENT QUESTION ${'问'.repeat(4_000)}`,
      context: '知识'.repeat(400_000),
      chatContext: [`recent-history ${'h'.repeat(20_000)}`],
    });

    const request = (generateText as jest.Mock).mock.calls[0][0] as {
      system: string;
      prompt: string;
    };
    expect(request.system.length + request.prompt.length).toBeLessThanOrEqual(
      700_000,
    );
    expect(request.prompt).toContain('CURRENT QUESTION');
    expect(request.prompt).toContain('recent-history');
  });

  it('does not trim conversation context when the total input is below the safeguard', async () => {
    const openaiProvider = jest.fn().mockReturnValue('openai-model');
    (createOpenAI as jest.Mock).mockReturnValue(openaiProvider);
    const service = createService({
      aiDriver: 'openai',
      aiChatMaxInputChars: 700_000,
    });
    const history = `history-start ${'h'.repeat(150_000)} history-end`;

    await service.answer({
      query: 'Q',
      context: 'Context',
      chatContext: [history],
    });

    const prompt = (generateText as jest.Mock).mock.calls[0][0]
      .prompt as string;
    expect(prompt).toContain('history-start');
    expect(prompt).toContain('history-end');
  });

  it('exposes the model text stream without buffering the answer', async () => {
    const openaiProvider = jest.fn().mockReturnValue('openai-model');
    (createOpenAI as jest.Mock).mockReturnValue(openaiProvider);
    (streamText as jest.Mock).mockReturnValue({
      textStream: (async function* () {
        yield 'first ';
        yield 'second';
      })(),
    });
    const service = createService({ aiDriver: 'openai' });

    const tokens: string[] = [];
    for await (const token of service.stream({
      query: 'Q',
      context: 'Context',
    })) {
      tokens.push(token);
    }

    expect(tokens).toEqual(['first ', 'second']);
    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'openai-model' }),
    );
  });
});

function createService(input: {
  aiDriver?: string;
  aiChatModel?: string;
  aiChatMaxInputChars?: number;
  openAiApiKey?: string;
  openAiApiUrl?: string;
  geminiApiKey?: string;
  ollamaApiUrl?: string;
}) {
  const environmentService = {
    getAiDriver: jest.fn().mockReturnValue(input.aiDriver),
    getAiChatModel: jest.fn().mockReturnValue(input.aiChatModel ?? 'model'),
    getAiChatMaxInputChars: jest
      .fn()
      .mockReturnValue(input.aiChatMaxInputChars ?? 700_000),
    getOpenAiApiKey: jest.fn().mockReturnValue(input.openAiApiKey),
    getOpenAiApiUrl: jest.fn().mockReturnValue(input.openAiApiUrl),
    getGeminiApiKey: jest.fn().mockReturnValue(input.geminiApiKey),
    getOllamaApiUrl: jest.fn().mockReturnValue(input.ollamaApiUrl),
  };

  return new ConfiguredKnowledgeAnswerProvider(
    environmentService as unknown as EnvironmentService,
  );
}
