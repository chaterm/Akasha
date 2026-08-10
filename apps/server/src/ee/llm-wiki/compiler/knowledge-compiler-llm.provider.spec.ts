import {
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
} from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
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
jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: jest.fn(),
}));

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

  it.each([['openai-compatible', createOpenAICompatible]])(
    'creates the configured %s completion model',
    async (driver, factory) => {
      const modelFactory = jest.fn().mockReturnValue('compiler-model');
      (factory as jest.Mock).mockReturnValue(modelFactory);
      (generateText as jest.Mock).mockResolvedValue({
        output: JSON.parse(analysisJson),
      });
      const provider = createProvider({ aiDriver: driver });

      await expect(
        provider.analyze({ system: 'system', prompt: 'prompt' }),
      ).resolves.toMatchObject({ synopsis: 'Summary' });

      expect(modelFactory).toHaveBeenCalledWith('knowledge-compiler-model');
      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'compiler-model',
          system: 'system',
          prompt: 'prompt',
          temperature: 0.1,
          maxOutputTokens: 16_384,
          abortSignal: expect.any(AbortSignal),
          output: expect.objectContaining({
            name: 'knowledge_compiler_analysis_v1',
            type: 'json',
          }),
        }),
      );
      expect(Output.json).toHaveBeenCalled();
    },
  );

  it('disables provider thinking for non-GPT OpenAI-compatible compiler models', async () => {
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockResolvedValue({
      output: JSON.parse(analysisJson),
    });

    await createProvider({ aiDriver: 'openai-compatible' }).analyze({
      system: 'system',
      prompt: 'prompt',
    });

    expect(createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'knowledgeCompiler' }),
    );
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          knowledgeCompiler: { enable_thinking: false },
        },
      }),
    );
  });

  it('uses fixed low reasoning effort and omits temperature for GPT compiler models', async () => {
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockResolvedValue({
      output: JSON.parse(analysisJson),
    });

    await createProvider({
      aiDriver: 'openai-compatible',
      compilerModel: 'openai-gpt-5.6-luna',
    }).analyze({
      system: 'system',
      prompt: 'prompt',
    });

    const request = (generateText as jest.Mock).mock.calls[0][0];
    expect(request).not.toHaveProperty('temperature');
    expect(request.providerOptions).toEqual({
      openaiCompatible: { reasoningEffort: 'low' },
    });
  });

  it('uses the configured hard timeout for every model request', async () => {
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockResolvedValue({
      output: JSON.parse(analysisJson),
    });
    const timeoutSpy = jest.spyOn(global, 'setTimeout');

    await createProvider({
      aiDriver: 'openai-compatible',
      compilerTimeoutMs: 45_000,
    }).analyze({ system: 'system', prompt: 'prompt' });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 45_000);
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    timeoutSpy.mockRestore();
  });

  it('binds initial and repair requests to the same parent deadline', async () => {
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    let resolveRepair!: (value: unknown) => void;
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { version: 1 } })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRepair = resolve;
          }),
      );
    const parent = new AbortController();

    const operation = createProvider({ aiDriver: 'openai-compatible' }).analyze(
      { system: 'system', prompt: 'prompt' },
      { abortSignal: parent.signal },
    );
    // Flush enough microtasks to advance through config resolution, the
    // initial request, and into the repair request.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(generateText).toHaveBeenCalledTimes(2);
    const repairSignal = (generateText as jest.Mock).mock.calls[1][0]
      .abortSignal as AbortSignal;
    parent.abort(new Error('page deadline'));
    expect(repairSignal.aborted).toBe(true);
    resolveRepair({ output: JSON.parse(analysisJson) });
    await expect(operation).resolves.toMatchObject({ synopsis: 'Summary' });
  });

  it('classifies TimeoutError as a retryable timeout', async () => {
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockRejectedValue(
      Object.assign(new Error('private timeout detail'), {
        name: 'TimeoutError',
      }),
    );

    await expect(
      createProvider({ aiDriver: 'openai-compatible' }).analyze({
        system: 'system',
        prompt: 'prompt',
      }),
    ).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
      message: 'Knowledge compiler provider timed out.',
    });
  });

  it('parses Stage 2 output with the generation schema', async () => {
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockResolvedValue({
      output: JSON.parse(generationJson),
    });

    await expect(
      createProvider({ aiDriver: 'openai-compatible' }).generate({
        system: 'system',
        prompt: 'prompt',
      }),
    ).resolves.toMatchObject({
      artifacts: [{ kind: 'source_summary', canonicalKey: 'page-1' }],
    });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 16_384 }),
    );
  });

  it('uses JSON mode and validates canonical merge output', async () => {
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockResolvedValue({
      output: { title: 'Merged title', markdown: 'Merged body' },
    });

    await expect(
      createProvider({ aiDriver: 'openai-compatible' }).completeMerge?.({
        system: 'system',
        prompt: 'prompt',
      }),
    ).resolves.toBe(
      JSON.stringify({ title: 'Merged title', markdown: 'Merged body' }),
    );
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 8_192,
        output: expect.objectContaining({
          name: 'knowledge_compiler_merge_v1',
        }),
      }),
    );
  });

  it('fails fast when the compiler model is not configured', async () => {
    const provider = createProvider({
      aiDriver: 'openai-compatible',
      compilerModel: '',
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
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    const structuredOutputError = new Error('private source text and not JSON');
    (
      NoOutputGeneratedError.isInstance as unknown as jest.Mock
    ).mockImplementation((error) => error === structuredOutputError);
    (generateText as jest.Mock).mockRejectedValue(structuredOutputError);

    await expect(
      createProvider({ aiDriver: 'openai-compatible' }).analyze({
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
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockRejectedValue(
      Object.assign(new Error('private quota detail'), { statusCode: 429 }),
    );

    await expect(
      createProvider({ aiDriver: 'openai-compatible' }).generate({
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

  it('does not misclassify a 5xx provider failure as oversized from message text', async () => {
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockRejectedValue(
      Object.assign(new Error('maximum context service unavailable'), {
        statusCode: 503,
      }),
    );

    await expect(
      createProvider({ aiDriver: 'openai-compatible' }).analyze({
        system: 'system',
        prompt: 'prompt',
      }),
    ).rejects.toMatchObject({
      code: 'provider_error',
      retryable: true,
    });
  });

  it('classifies a retry-wrapped provider rate limit from the last error', async () => {
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    const upstream = Object.assign(new Error('private quota detail'), {
      name: 'AI_APICallError',
      statusCode: 429,
      isRetryable: true,
      data: {
        error: {
          code: 'Throttling',
          type: 'rate_limit_error',
          message: 'private quota detail',
        },
      },
      responseHeaders: { 'x-request-id': 'request-429' },
    });
    (generateText as jest.Mock).mockRejectedValue(
      Object.assign(new Error('private retry wrapper detail'), {
        name: 'AI_RetryError',
        reason: 'maxRetriesExceeded',
        errors: [upstream, upstream, upstream],
        lastError: upstream,
      }),
    );

    await expect(
      createProvider({ aiDriver: 'openai-compatible' }).analyze({
        system: 'system',
        prompt: 'prompt',
      }),
    ).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
      message: 'Knowledge compiler provider rate limit was exceeded.',
      diagnostic: {
        wrapperName: 'AI_RetryError',
        upstreamName: 'AI_APICallError',
        statusCode: 429,
        providerCode: 'Throttling',
        providerType: 'rate_limit_error',
        requestId: 'request-429',
        retryReason: 'maxRetriesExceeded',
        sdkAttempts: 3,
      },
    });
  });

  it('keeps retry-wrapped provider input errors non-retryable and diagnostic', async () => {
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    const upstream = Object.assign(new Error('private context detail'), {
      name: 'AI_APICallError',
      statusCode: 400,
      isRetryable: false,
      data: {
        error: {
          code: 'InvalidParameter',
          type: 'invalid_request_error',
          message: 'private context detail',
        },
      },
      responseHeaders: { 'x-dashscope-request-id': 'request-400' },
    });
    (generateText as jest.Mock).mockRejectedValue(
      Object.assign(new Error('private retry wrapper detail'), {
        name: 'AI_RetryError',
        reason: 'errorNotRetryable',
        errors: [upstream],
        lastError: upstream,
      }),
    );

    await expect(
      createProvider({ aiDriver: 'openai-compatible' }).analyze({
        system: 'system',
        prompt: 'prompt',
      }),
    ).rejects.toMatchObject({
      code: 'provider_error',
      retryable: false,
      message: 'Knowledge compiler provider request failed.',
      diagnostic: {
        statusCode: 400,
        providerCode: 'InvalidParameter',
        providerType: 'invalid_request_error',
        requestId: 'request-400',
        sdkAttempts: 1,
      },
    });
  });

  it('classifies HTTP 413 as a non-retryable oversized input', async () => {
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockRejectedValue(
      Object.assign(new Error('private request body'), { statusCode: 413 }),
    );

    await expect(
      createProvider({ aiDriver: 'openai-compatible' }).analyze({
        system: 'system',
        prompt: 'private source text',
      }),
    ).rejects.toMatchObject({
      code: 'input_too_large',
      retryable: false,
      diagnosticClass: 'oversized',
      message: 'Knowledge compiler input exceeds the provider context limit.',
    });
  });

  it.each([
    ['context_length_exceeded', 'input exceeds the context window'],
    ['InvalidParameter', 'Maximum context length is 1000 tokens'],
    ['InvalidParameter', 'request too large for token limit'],
    ['maximum_context', 'provider only returned a code'],
    ['token_limit', 'provider only returned a type'],
  ])(
    'classifies context overflow 400 code=%s as oversized',
    async (code, message) => {
      (createOpenAICompatible as jest.Mock).mockReturnValue(
        jest.fn().mockReturnValue('compiler-model'),
      );
      (generateText as jest.Mock).mockRejectedValue(
        Object.assign(new Error('private provider wrapper'), {
          status: 400,
          data: {
            error:
              code === 'token_limit'
                ? { type: code, message }
                : { code, message },
          },
        }),
      );

      await expect(
        createProvider({ aiDriver: 'openai-compatible' }).generate({
          system: 'system',
          prompt: 'private source text',
        }),
      ).rejects.toMatchObject({
        code: 'input_too_large',
        retryable: false,
        diagnosticClass: 'oversized',
      });
    },
  );

  it('classifies a retry-wrapped timeout from the upstream cause', async () => {
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    const timeout = Object.assign(new Error('private timeout detail'), {
      name: 'TimeoutError',
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    const upstream = Object.assign(new Error('private API detail'), {
      name: 'AI_APICallError',
      cause: timeout,
      isRetryable: true,
    });
    (generateText as jest.Mock).mockRejectedValue(
      Object.assign(new Error('private retry wrapper detail'), {
        name: 'AI_RetryError',
        reason: 'maxRetriesExceeded',
        errors: [upstream, upstream],
        lastError: upstream,
      }),
    );

    await expect(
      createProvider({ aiDriver: 'openai-compatible' }).analyze({
        system: 'system',
        prompt: 'prompt',
      }),
    ).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
      message: 'Knowledge compiler provider timed out.',
      diagnostic: {
        wrapperName: 'AI_RetryError',
        upstreamName: 'AI_APICallError',
        upstreamCode: 'UND_ERR_CONNECT_TIMEOUT',
        sdkAttempts: 2,
      },
    });
  });

  it('classifies schema validation failures without exposing model output', async () => {
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    const schemaError = new Error('private malformed generation output');
    (
      NoObjectGeneratedError.isInstance as unknown as jest.Mock
    ).mockImplementation((error) => error === schemaError);
    (generateText as jest.Mock).mockRejectedValue(schemaError);

    await expect(
      createProvider({ aiDriver: 'openai-compatible' }).generate({
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
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockResolvedValue({
      output: { version: 1 },
    });

    await expect(
      createProvider({ aiDriver: 'openai-compatible' }).analyze({
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
    (createOpenAICompatible as jest.Mock).mockReturnValue(
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
      createProvider({ aiDriver: 'openai-compatible' }).generate({
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
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { version: 1 } })
      .mockResolvedValueOnce({ output: JSON.parse(analysisJson) });

    await expect(
      createProvider({ aiDriver: 'openai-compatible' }).analyze({
        system: 'system',
        prompt: '<output_contract>{"version":"1"}</output_contract>',
      }),
    ).resolves.toMatchObject({ synopsis: 'Summary' });

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        maxOutputTokens: 16_384,
        system: expect.stringContaining('repair invalid analysis JSON'),
        prompt: expect.stringContaining('<validation_errors>'),
        output: expect.objectContaining({
          name: 'knowledge_compiler_analysis_v1_repair',
        }),
      }),
    );
  });

  it('publishes a deterministic source summary fallback after generation repair fails', async () => {
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockResolvedValue({ output: { version: 1 } });

    await expect(
      createProvider({ aiDriver: 'openai-compatible' }).generate(
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

  it('hard-bounds fallback Markdown even when a caller supplies too much text', async () => {
    (createOpenAICompatible as jest.Mock).mockReturnValue(
      jest.fn().mockReturnValue('compiler-model'),
    );
    (generateText as jest.Mock).mockResolvedValue({ output: { version: 1 } });

    const result = await createProvider({
      aiDriver: 'openai-compatible',
    }).generate(
      { system: 'system', prompt: 'prompt' },
      {
        canonicalKey: 'source-page-1',
        title: 'Original title',
        markdown: 'x'.repeat(20_000),
      },
    );

    expect(result.artifacts[0].markdown).toHaveLength(8_000);
  });
});

function createProvider(input: {
  aiDriver: string;
  compilerModel?: string;
  compilerTimeoutMs?: number;
  compilerMaxOutputTokens?: number;
  imageMergeMaxOutputTokens?: number;
}): ConfiguredKnowledgeCompilerLlmProvider {
  const environmentService = {
    getKnowledgeCompilerMaxOutputTokens: jest.fn(
      () => input.compilerMaxOutputTokens ?? 16_384,
    ),
    getKnowledgeImageMergeMaxOutputTokens: jest.fn(
      () => input.imageMergeMaxOutputTokens ?? 8_192,
    ),
    getKnowledgeCompilerTimeoutMs: jest.fn(
      () => input.compilerTimeoutMs ?? 300_000,
    ),
  } as never;
  const configService = {
    getResolvedConfig: jest.fn(async () => ({
      driver: input.aiDriver,
      model: input.compilerModel ?? 'knowledge-compiler-model',
      apiKey: 'openai-key',
      baseUrl: 'https://openai.example/v1',
      parameters: {},
      fromDatabase: false,
    })),
    invalidate: jest.fn(),
  } as never;
  return new ConfiguredKnowledgeCompilerLlmProvider(
    environmentService,
    configService,
  );
}

void KnowledgeCompilerLlmError;
