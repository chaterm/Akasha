import { Injectable, Logger } from '@nestjs/common';
import { embed, generateText } from 'ai';
import { AiModelConfigFeature } from '../../../database/repos/llm-wiki/ai-model-config.repo';
import {
  AiModelConfigService,
  ResolvedAiModelConfig,
} from './ai-model-config.service';
import {
  createEmbeddingModelFromConfig,
  createLanguageModelFromConfig,
} from './ai-model-factory';
import { resolveModelCallOptions } from './ai-model-call-options';

// Values the admin currently has in the form. apiKey omitted/blank means "reuse
// the stored key" — the same write-only rule as saving.
export type TestAiModelConfigInput = {
  provider: string;
  model: string;
  baseUrl?: string | null;
  apiKey?: string;
  parameters?: Record<string, unknown> | null;
};

export type TestAiModelConfigResult = {
  ok: boolean;
  code?: string;
  message?: string;
  latencyMs?: number;
};

const TEST_TIMEOUT_MS = 15_000;
const FACTORY_NAME = 'akashaConfigTest';

@Injectable()
export class AiModelConfigTestService {
  private readonly logger = new Logger(AiModelConfigTestService.name);

  constructor(private readonly configService: AiModelConfigService) {}

  async testConfig(
    feature: AiModelConfigFeature,
    input: TestAiModelConfigInput,
  ): Promise<TestAiModelConfigResult> {
    const config = await this.buildConfig(feature, input);
    const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
    const startedAt = Date.now();

    try {
      if (feature === 'embedding') {
        const model = createEmbeddingModelFromConfig(config, FACTORY_NAME);
        if (!model) return notConfigured();
        await embed({ model, value: 'ping', abortSignal: signal });
      } else {
        const model = createLanguageModelFromConfig(config, FACTORY_NAME);
        if (!model) return notConfigured();
        await generateText({
          model,
          prompt: 'ping',
          ...resolveModelCallOptions(config, {
            providerOptionsName: FACTORY_NAME,
          }),
          maxOutputTokens: 1,
          abortSignal: signal,
        });
      }
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      const result = classifyTestError(error, signal);
      this.logger.warn(
        `Model config test failed for "${feature}": ${result.code} ${result.message ?? ''}`.trim(),
      );
      return result;
    }
  }

  // Merge the form values with the stored config. When the admin leaves the
  // apiKey blank we fall back to the stored (decrypted) key so tests work for
  // configs where only the model or base URL changed.
  private async buildConfig(
    feature: AiModelConfigFeature,
    input: TestAiModelConfigInput,
  ): Promise<ResolvedAiModelConfig> {
    let apiKey = input.apiKey;
    if (apiKey === undefined || apiKey === '') {
      const stored = await this.configService.getResolvedConfig(feature);
      apiKey = stored.apiKey;
    }
    return {
      driver: input.provider,
      model: input.model,
      apiKey,
      baseUrl: input.baseUrl ?? undefined,
      parameters: input.parameters ?? {},
      fromDatabase: false,
    };
  }
}

function notConfigured(): TestAiModelConfigResult {
  return {
    ok: false,
    code: 'not_configured',
    message: 'Model configuration is incomplete.',
  };
}

// Distinguish transport/quota failures (network, 429, timeout) from credential
// and other provider errors, mirroring classifyRequiredEmbeddingError.
function classifyTestError(
  error: unknown,
  signal: AbortSignal,
): TestAiModelConfigResult {
  if (signal.aborted) {
    return {
      ok: false,
      code: 'timeout',
      message: 'The provider did not respond within the time limit.',
    };
  }

  const status = providerStatus(error);
  if (status === 429) {
    return {
      ok: false,
      code: 'rate_limited',
      message: 'The provider rate limit was reached.',
    };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      code: 'auth_failed',
      message: 'The provider rejected the credentials.',
    };
  }
  return {
    ok: false,
    code: 'provider_error',
    message: errorMessage(error),
  };
}

function providerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  for (const key of ['statusCode', 'status'] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === 'number') return value;
  }
  const response = (error as Record<string, unknown>).response;
  if (response && typeof response === 'object') {
    const status = (response as Record<string, unknown>).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'The provider request failed.';
}
