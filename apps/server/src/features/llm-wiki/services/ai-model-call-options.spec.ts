import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  resolveModelCallOptions,
  stableCallOptionsKey,
} from './ai-model-call-options';
import type { ResolvedAiModelConfig } from './ai-model-config.service';

const PROVIDER = 'akashaAnswer';

describe('resolveModelCallOptions', () => {
  it.each(['qwen3.8-27b', 'deepseek', 'glm', 'office-model', 'gpt-4o'])(
    'disables thinking by default for %s without requiring a model-name match',
    (model) => {
      expect(
        resolveModelCallOptions(config({}, model), {
          providerOptionsName: PROVIDER,
        }),
      ).toEqual({
        providerOptions: {
          [PROVIDER]: { chat_template_kwargs: { enable_thinking: false } },
        },
      });
    },
  );

  it('does not let reasoningEffort implicitly enable thinking', () => {
    expect(
      resolveModelCallOptions(config({ reasoningEffort: 'high' }), {
        providerOptionsName: PROVIDER,
      }),
    ).toEqual({
      providerOptions: {
        [PROVIDER]: { chat_template_kwargs: { enable_thinking: false } },
      },
    });
  });

  it('enables thinking only when explicitly configured', () => {
    expect(
      resolveModelCallOptions(config({ thinkingEnabled: true }), {
        providerOptionsName: PROVIDER,
      }),
    ).toEqual({
      providerOptions: {
        [PROVIDER]: { chat_template_kwargs: { enable_thinking: true } },
      },
    });
  });

  it.each([undefined, false])(
    'explicitly disables OpenAI reasoning when thinkingEnabled is %s',
    (thinkingEnabled) => {
      expect(
        resolveModelCallOptions(config({ thinkingEnabled }), {
          providerOptionsName: PROVIDER,
          defaultThinkingMode: 'openai',
          defaultTemperature: 0.1,
        }),
      ).toEqual({
        providerOptions: { openaiCompatible: { reasoningEffort: 'none' } },
      });
    },
  );

  it('does not let reasoningEffort implicitly enable OpenAI thinking', () => {
    expect(
      resolveModelCallOptions(
        config({ thinkingMode: 'openai', reasoningEffort: 'high' }),
        { providerOptionsName: PROVIDER },
      ),
    ).toEqual({
      providerOptions: { openaiCompatible: { reasoningEffort: 'none' } },
    });
  });

  it('applies the feature default temperature only when unset', () => {
    expect(
      resolveModelCallOptions(config({}, 'gpt-4o'), {
        providerOptionsName: PROVIDER,
        defaultTemperature: 0,
      }),
    ).toEqual({
      temperature: 0,
      providerOptions: {
        [PROVIDER]: { chat_template_kwargs: { enable_thinking: false } },
      },
    });

    expect(
      resolveModelCallOptions(config({ temperature: 0.7 }, 'gpt-4o'), {
        providerOptionsName: PROVIDER,
        defaultTemperature: 0,
      }),
    ).toEqual({
      temperature: 0.7,
      providerOptions: {
        [PROVIDER]: { chat_template_kwargs: { enable_thinking: false } },
      },
    });
  });

  it('keys Qwen thinking under the provider name so the SDK passes it through', () => {
    expect(
      resolveModelCallOptions(
        config({
          thinkingMode: 'qwen',
          thinkingEnabled: true,
          reasoningEffort: 'medium',
          seed: 7,
        }),
        { providerOptionsName: PROVIDER, defaultTemperature: 0 },
      ),
    ).toEqual({
      temperature: 0,
      seed: 7,
      providerOptions: {
        [PROVIDER]: {
          chat_template_kwargs: {
            enable_thinking: true,
            reasoning_effort: 'medium',
          },
        },
      },
    });
  });

  it('keeps Qwen thinking off when explicitly disabled', () => {
    expect(
      resolveModelCallOptions(
        config({ thinkingMode: 'qwen', thinkingEnabled: false }),
        { providerOptionsName: PROVIDER },
      ).providerOptions,
    ).toEqual({
      [PROVIDER]: { chat_template_kwargs: { enable_thinking: false } },
    });
  });

  it('defaults explicitly selected Qwen mode to thinking off for model aliases', () => {
    expect(
      resolveModelCallOptions(
        config({ thinkingMode: 'qwen' }, 'office-model'),
        {
          providerOptionsName: PROVIDER,
        },
      ),
    ).toEqual({
      providerOptions: {
        [PROVIDER]: {
          chat_template_kwargs: { enable_thinking: false },
        },
      },
    });
  });

  it('lets an explicit mode override the feature protocol default', () => {
    expect(
      resolveModelCallOptions(
        config({ thinkingMode: 'qwen', thinkingEnabled: true }),
        {
          providerOptionsName: PROVIDER,
          defaultThinkingMode: 'openai',
        },
      ),
    ).toEqual({
      providerOptions: {
        [PROVIDER]: {
          chat_template_kwargs: { enable_thinking: true },
        },
      },
    });
  });

  it('drops reasoning_effort when Qwen thinking is off', () => {
    const options = resolveModelCallOptions(
      config({
        thinkingMode: 'qwen',
        thinkingEnabled: false,
        reasoningEffort: 'high',
      }),
      { providerOptionsName: PROVIDER },
    );
    expect(
      (options.providerOptions?.[PROVIDER] as Record<string, unknown>)
        .chat_template_kwargs,
    ).toEqual({ enable_thinking: false });
  });

  it('suppresses temperature and seed for the OpenAI reasoning dialect', () => {
    expect(
      resolveModelCallOptions(
        config({
          thinkingMode: 'openai',
          thinkingEnabled: true,
          reasoningEffort: 'low',
          temperature: 0.5,
          seed: 7,
          topP: 0.9,
        }),
        { providerOptionsName: PROVIDER, defaultTemperature: 0 },
      ),
    ).toEqual({
      providerOptions: { openaiCompatible: { reasoningEffort: 'low' } },
    });
  });

  it('disables thinking for callers that share another feature config row', () => {
    expect(
      resolveModelCallOptions(
        config({ thinkingMode: 'qwen', reasoningEffort: 'high', seed: 7 }),
        {
          providerOptionsName: PROVIDER,
          defaultTemperature: 0,
        },
      ),
    ).toEqual({
      temperature: 0,
      seed: 7,
      providerOptions: {
        [PROVIDER]: { chat_template_kwargs: { enable_thinking: false } },
      },
    });
  });

  it('still sends sampling for a non-reasoning OpenAI model', () => {
    expect(
      resolveModelCallOptions(config({ temperature: 0.3 }, 'gpt-4o'), {
        providerOptionsName: PROVIDER,
      }),
    ).toEqual({
      temperature: 0.3,
      providerOptions: {
        [PROVIDER]: { chat_template_kwargs: { enable_thinking: false } },
      },
    });
  });

  it('drops unusable values from a hand-edited row', () => {
    expect(
      resolveModelCallOptions(
        config({
          temperature: 'hot',
          seed: Number.NaN,
          thinkingMode: 'deepseek',
          reasoningEffort: 'extreme',
        }),
        { providerOptionsName: PROVIDER },
      ),
    ).toEqual({
      providerOptions: {
        [PROVIDER]: { chat_template_kwargs: { enable_thinking: false } },
      },
    });
  });
});

describe('thinking options in the SDK request body', () => {
  it.each([
    {
      parameters: {},
      expected: { chat_template_kwargs: { enable_thinking: false } },
    },
    {
      parameters: { thinkingMode: 'openai', reasoningEffort: 'high' },
      expected: { reasoning_effort: 'none' },
    },
  ])(
    'sends the disabled intent for $parameters',
    async ({ parameters, expected }) => {
      const requests: Record<string, unknown>[] = [];
      const model = createOpenAICompatible({
        name: PROVIDER,
        baseURL: 'https://llm.example/v1',
        fetch: async (_url, init) => {
          requests.push(JSON.parse(init?.body as string));
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: { role: 'assistant', content: 'OK' },
                  finish_reason: 'stop',
                },
              ],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        },
      })('office-model');

      await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        ...resolveModelCallOptions(config(parameters, 'office-model'), {
          providerOptionsName: PROVIDER,
        }),
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ model: 'office-model', ...expected });
    },
  );
});

describe('stableCallOptionsKey', () => {
  it('is independent of key order so an equivalent config caches the same', () => {
    const a = resolveModelCallOptions(
      config({
        thinkingMode: 'qwen',
        reasoningEffort: 'low',
        temperature: 0.1,
      }),
      { providerOptionsName: PROVIDER },
    );
    const b = resolveModelCallOptions(
      config({
        temperature: 0.1,
        reasoningEffort: 'low',
        thinkingMode: 'qwen',
      }),
      { providerOptionsName: PROVIDER },
    );
    expect(stableCallOptionsKey(a)).toBe(stableCallOptionsKey(b));
  });

  it('changes when thinking is retuned, so cached output is invalidated', () => {
    const on = resolveModelCallOptions(
      config({ thinkingMode: 'qwen', thinkingEnabled: true }),
      { providerOptionsName: PROVIDER },
    );
    const off = resolveModelCallOptions(
      config({ thinkingMode: 'qwen', thinkingEnabled: false }),
      { providerOptionsName: PROVIDER },
    );
    expect(stableCallOptionsKey(on)).not.toBe(stableCallOptionsKey(off));
  });
});

function config(
  parameters: Record<string, unknown> = {},
  model = 'qwen3-32b',
): ResolvedAiModelConfig {
  return {
    driver: 'openai-compatible',
    model,
    apiKey: 'key',
    baseUrl: 'https://llm.example/v1',
    parameters,
    fromDatabase: true,
  };
}
