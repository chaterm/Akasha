import {
  resolveModelCallOptions,
  stableCallOptionsKey,
} from './ai-model-call-options';
import type { ResolvedAiModelConfig } from './ai-model-config.service';

const PROVIDER = 'akashaAnswer';

describe('resolveModelCallOptions', () => {
  it('sends nothing when the config carries no parameters', () => {
    expect(
      resolveModelCallOptions(config(), { providerOptionsName: PROVIDER }),
    ).toEqual({});
  });

  it('sends the feature thinking default when the config omits it', () => {
    expect(
      resolveModelCallOptions(config(), {
        providerOptionsName: PROVIDER,
        defaultThinkingEnabled: false,
      }),
    ).toEqual({
      providerOptions: {
        [PROVIDER]: { chat_template_kwargs: { enable_thinking: false } },
      },
    });
  });

  it('prefers the configured thinking flag over the feature default', () => {
    expect(
      resolveModelCallOptions(config({ thinkingEnabled: true }), {
        providerOptionsName: PROVIDER,
        defaultThinkingEnabled: false,
      }),
    ).toEqual({
      providerOptions: {
        [PROVIDER]: { chat_template_kwargs: { enable_thinking: true } },
      },
    });
  });

  it('keeps the OpenAI dialect when the model is a reasoning model', () => {
    expect(
      resolveModelCallOptions(config({ thinkingEnabled: false }), {
        providerOptionsName: PROVIDER,
        defaultThinkingMode: 'openai',
        defaultTemperature: 0.1,
      }),
    ).toEqual({});
  });

  it('applies the feature default temperature only when unset', () => {
    expect(
      resolveModelCallOptions(config(), {
        providerOptionsName: PROVIDER,
        defaultTemperature: 0,
      }),
    ).toEqual({ temperature: 0 });

    expect(
      resolveModelCallOptions(config({ temperature: 0.7 }), {
        providerOptionsName: PROVIDER,
        defaultTemperature: 0,
      }),
    ).toEqual({ temperature: 0.7 });
  });

  it('keys Qwen thinking under the provider name so the SDK passes it through', () => {
    expect(
      resolveModelCallOptions(
        config({ thinkingMode: 'qwen', reasoningEffort: 'medium', seed: 7 }),
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

  it('turns Qwen thinking off explicitly, which is not the same as omitting it', () => {
    expect(
      resolveModelCallOptions(
        config({ thinkingMode: 'qwen', thinkingEnabled: false }),
        { providerOptionsName: PROVIDER },
      ).providerOptions,
    ).toEqual({
      [PROVIDER]: { chat_template_kwargs: { enable_thinking: false } },
    });
  });

  it('applies a feature default for Qwen thinking without changing other callers', () => {
    expect(
      resolveModelCallOptions(config(), {
        providerOptionsName: PROVIDER,
        defaultThinkingMode: 'qwen',
        defaultThinkingEnabled: false,
      }),
    ).toEqual({
      providerOptions: {
        [PROVIDER]: {
          chat_template_kwargs: { enable_thinking: false },
        },
      },
    });
  });

  it('lets an explicit thinking setting override the feature default', () => {
    expect(
      resolveModelCallOptions(
        config({ thinkingMode: 'qwen', thinkingEnabled: true }),
        {
          providerOptionsName: PROVIDER,
          defaultThinkingMode: 'openai',
          defaultThinkingEnabled: false,
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

  it('ignores thinking for callers that share another feature config row', () => {
    expect(
      resolveModelCallOptions(
        config({ thinkingMode: 'qwen', reasoningEffort: 'high', seed: 7 }),
        {
          providerOptionsName: PROVIDER,
          defaultTemperature: 0,
          ignoreThinking: true,
        },
      ),
    ).toEqual({ temperature: 0, seed: 7 });
  });

  it('still sends sampling for a non-reasoning OpenAI model', () => {
    expect(
      resolveModelCallOptions(config({ temperature: 0.3 }, 'gpt-4o'), {
        providerOptionsName: PROVIDER,
      }),
    ).toEqual({ temperature: 0.3 });
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
    ).toEqual({});
  });
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
    const on = resolveModelCallOptions(config({ thinkingMode: 'qwen' }), {
      providerOptionsName: PROVIDER,
    });
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
