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
  // True when a database row exists. False means the capability is not
  // configured; LLM Wiki no longer synthesizes model config from .env fallback.
  fromDatabase: boolean;
};

// Feature -> masked view returned to admins (never exposes the API key value).
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

  // Masked view for the admin UI: one entry per feature, API key never exposed.
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
      // undefined => keep existing key; '' => clear; otherwise set/replace.
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

    const saved = await this.repo.upsert(feature, {
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl ?? null,
      apiKeyEncrypted,
      parameters: (input.parameters ??
        null) as InsertableAiModelConfig['parameters'],
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
        `Failed to load AI model config for "${feature}". Returning unconfigured model config.`,
        error instanceof Error ? error.stack : String(error),
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
          `Failed to decrypt API key for "${feature}". Returning config without API key.`,
          error instanceof Error ? error.stack : String(error),
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
