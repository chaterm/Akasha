import { Injectable, Logger } from '@nestjs/common';
import {
  AiModelConfigFeature,
  AiModelConfigRepo,
} from '../../../database/repos/llm-wiki/ai-model-config.repo';
import { AiConfigSecretService } from './ai-config-secret.service';
import {
  AiModelConfig,
  InsertableAiModelConfig,
} from '@akasha/db/types/entity.types';

export type ResolvedAiModelConfig = {
  driver: string | undefined;
  model: string | undefined;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  parameters: Record<string, unknown>;
  fromDatabase: boolean;
};

export type AiModelConfigView = {
  feature: AiModelConfigFeature;
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  apiKeySet: boolean;
  parameters: Record<string, unknown> | null;
};

const CACHE_TTL_MS = 10_000;

@Injectable()
export class AiModelConfigService {
  private readonly logger = new Logger(AiModelConfigService.name);
  private cache = new Map<
    AiModelConfigFeature,
    { value: ResolvedAiModelConfig; expiresAt: number }
  >();

  constructor(
    private readonly repo: AiModelConfigRepo,
    private readonly secretService: AiConfigSecretService,
  ) {}

  invalidate(feature?: AiModelConfigFeature): void {
    if (feature) {
      this.cache.delete(feature);
    } else {
      this.cache.clear();
    }
  }

  private readonly features: AiModelConfigFeature[] = [
    'compiler',
    'answer',
    'image',
    'embedding',
  ];

  async listConfigViews(): Promise<AiModelConfigView[]> {
    const rows = await this.repo.findAll();
    const byFeature = new Map(rows.map((row) => [row.feature, row]));
    return this.features.map((feature) => {
      const row = byFeature.get(feature);
      return {
        feature,
        provider: row?.provider ?? null,
        model: row?.model ?? null,
        baseUrl: row?.baseUrl ?? null,
        apiKeySet: Boolean(row?.apiKeyEncrypted),
        parameters: (row?.parameters as Record<string, unknown> | null) ?? null,
      };
    });
  }

  async updateConfig(
    feature: AiModelConfigFeature,
    input: {
      provider: string;
      model: string;
      baseUrl?: string | null;
      apiKey?: string;
      parameters?: Record<string, unknown> | null;
    },
  ): Promise<AiModelConfigView> {
    const existing = await this.repo.findByFeature(feature);

    let apiKeyEncrypted: string | null | undefined;
    if (input.apiKey === undefined) {
      apiKeyEncrypted = existing?.apiKeyEncrypted ?? null;
    } else if (input.apiKey === '') {
      apiKeyEncrypted = null;
    } else {
      apiKeyEncrypted = this.secretService.encrypt(input.apiKey);
    }

    let parameters: Record<string, unknown> | null;
    if (input.parameters === undefined) {
      parameters =
        (existing?.parameters as Record<string, unknown> | null) ?? null;
    } else {
      parameters = input.parameters;
    }

    const saved = await this.repo.upsert(feature, {
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl ?? null,
      apiKeyEncrypted,
      parameters: parameters as InsertableAiModelConfig['parameters'],
    });

    this.invalidate(feature);

    return {
      feature,
      provider: saved.provider,
      model: saved.model,
      baseUrl: saved.baseUrl,
      apiKeySet: Boolean(saved.apiKeyEncrypted),
      parameters: (saved.parameters as Record<string, unknown> | null) ?? null,
    };
  }

  async getResolvedConfig(
    feature: AiModelConfigFeature,
  ): Promise<ResolvedAiModelConfig> {
    const cached = this.cache.get(feature);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    let row: AiModelConfig | undefined;
    try {
      row = await this.repo.findByFeature(feature);
    } catch (error) {
      this.logger.error(
        { feature, err: error },
        'Failed to load AI model config; returning unconfigured model config',
      );
    }

    const resolved = row
      ? this.resolveFromRow(feature, row)
      : this.unconfiguredConfig();

    this.cache.set(feature, {
      value: resolved,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return resolved;
  }

  private resolveFromRow(
    feature: AiModelConfigFeature,
    row: AiModelConfig,
  ): ResolvedAiModelConfig {
    let apiKey: string | undefined;
    if (row.apiKeyEncrypted) {
      try {
        apiKey = this.secretService.decrypt(row.apiKeyEncrypted);
      } catch (error) {
        this.logger.error(
          { feature, err: error },
          'Failed to decrypt API key; returning config without API key',
        );
      }
    }

    return {
      driver: row.provider,
      model: row.model,
      apiKey,
      baseUrl: row.baseUrl ?? undefined,
      parameters: (row.parameters as Record<string, unknown> | null) ?? {},
      fromDatabase: true,
    };
  }

  private unconfiguredConfig(): ResolvedAiModelConfig {
    return {
      driver: undefined,
      model: undefined,
      apiKey: undefined,
      baseUrl: undefined,
      parameters: {},
      fromDatabase: false,
    };
  }
}
