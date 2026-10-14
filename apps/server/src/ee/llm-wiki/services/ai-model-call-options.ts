import type { ProviderOptions } from '@ai-sdk/provider-utils';
import type { ResolvedAiModelConfig } from './ai-model-config.service';

export type ThinkingMode = 'qwen' | 'openai';

export type ReasoningEffort = 'low' | 'medium' | 'high';

export type AiModelCallParameters = {
  temperature?: number;
  topP?: number;
  seed?: number;
  thinkingMode?: ThinkingMode;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
};

export type ModelCallOptions = {
  temperature?: number;
  topP?: number;
  seed?: number;
  providerOptions?: ProviderOptions;
};

export type ResolveModelCallOptionsInput = {
  providerOptionsName: string;
  defaultTemperature?: number;
  defaultThinkingMode?: ThinkingMode;
  defaultThinkingEnabled?: boolean;
  ignoreThinking?: boolean;
};

export function resolveModelCallOptions(
  config: ResolvedAiModelConfig,
  input: ResolveModelCallOptionsInput,
): ModelCallOptions {
  const parameters = readParameters(config);
  const thinkingIntent =
    parameters.thinkingEnabled ?? input.defaultThinkingEnabled;
  const thinkingMode = input.ignoreThinking
    ? undefined
    : (parameters.thinkingMode ??
      input.defaultThinkingMode ??
      (thinkingIntent === undefined ? undefined : 'qwen'));

  const samplingAllowed = thinkingMode !== 'openai';

  const temperature = samplingAllowed
    ? (parameters.temperature ?? input.defaultTemperature)
    : undefined;
  const seed = samplingAllowed ? parameters.seed : undefined;
  const topP = samplingAllowed ? parameters.topP : undefined;

  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(seed === undefined ? {} : { seed }),
    ...buildProviderOptions(
      thinkingMode,
      parameters,
      input.providerOptionsName,
      input.defaultThinkingEnabled,
    ),
  };
}

function buildProviderOptions(
  thinkingMode: ThinkingMode | undefined,
  parameters: AiModelCallParameters,
  providerOptionsName: string,
  defaultThinkingEnabled?: boolean,
): { providerOptions?: ProviderOptions } {
  if (thinkingMode === undefined) return {};

  if (thinkingMode === 'openai') {
    return parameters.reasoningEffort === undefined
      ? {}
      : {
          providerOptions: {
            openaiCompatible: { reasoningEffort: parameters.reasoningEffort },
          },
        };
  }

  const enableThinking =
    parameters.thinkingEnabled ?? defaultThinkingEnabled ?? true;
  return {
    providerOptions: {
      [providerOptionsName]: {
        chat_template_kwargs: {
          enable_thinking: enableThinking,
          ...(enableThinking && parameters.reasoningEffort !== undefined
            ? { reasoning_effort: parameters.reasoningEffort }
            : {}),
        },
      },
    },
  };
}

export function stableCallOptionsKey(options: ModelCallOptions): string {
  return JSON.stringify(options, sortedKeyReplacer);
}

function sortedKeyReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, source[key]]),
  );
}

const REASONING_EFFORTS: readonly string[] = ['low', 'medium', 'high'];
const THINKING_MODES: readonly string[] = ['qwen', 'openai'];

function readParameters(config: ResolvedAiModelConfig): AiModelCallParameters {
  const raw = config.parameters ?? {};
  return {
    ...(isFiniteNumber(raw.temperature)
      ? { temperature: raw.temperature }
      : {}),
    ...(isFiniteNumber(raw.topP) ? { topP: raw.topP } : {}),
    ...(isFiniteNumber(raw.seed) ? { seed: raw.seed } : {}),
    ...(typeof raw.thinkingMode === 'string' &&
    THINKING_MODES.includes(raw.thinkingMode)
      ? { thinkingMode: raw.thinkingMode as ThinkingMode }
      : {}),
    ...(typeof raw.thinkingEnabled === 'boolean'
      ? { thinkingEnabled: raw.thinkingEnabled }
      : {}),
    ...(typeof raw.reasoningEffort === 'string' &&
    REASONING_EFFORTS.includes(raw.reasoningEffort)
      ? { reasoningEffort: raw.reasoningEffort as ReasoningEffort }
      : {}),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
