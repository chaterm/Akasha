import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';

export type KnowledgeVectorIndexResult = 'created' | 'exists' | 'exact-only';

const MAX_HNSW_VECTOR_DIMENSIONS = 2000;
const PROFILE_PATTERN = /^[a-f0-9]{64}$/;

@Injectable()
export class KnowledgeVectorIndexService {
  private readonly logger = new Logger(KnowledgeVectorIndexService.name);
  private readonly inFlight = new Map<
    string,
    Promise<KnowledgeVectorIndexResult>
  >();

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async ensureProfileIndex(input: {
    profile: string;
    dimensions: number;
  }): Promise<KnowledgeVectorIndexResult> {
    validateInput(input);
    if (input.dimensions > MAX_HNSW_VECTOR_DIMENSIONS) {
      return 'exact-only';
    }

    const key = `${input.profile}:${input.dimensions}`;
    const existingRequest = this.inFlight.get(key);
    if (existingRequest) return existingRequest;

    const request = this.createProfileIndex(input).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);

    return request;
  }

  private async createProfileIndex(input: {
    profile: string;
    dimensions: number;
  }): Promise<KnowledgeVectorIndexResult> {
    const identifier = indexIdentifier(input);

    try {
      const existing = await this.executeStatement(
        `SELECT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = '${identifier}'
        ) AS exists`,
      );
      if (existing.rows[0]?.exists === true) return 'exists';

      await this.executeStatement(
        `CREATE INDEX IF NOT EXISTS ${identifier}
          ON knowledge_chunks USING hnsw
            ((embedding::vector(${input.dimensions})) vector_cosine_ops)
          WHERE embedding_profile = '${input.profile}'
            AND embedding_dimensions = ${input.dimensions}
            AND stale_at IS NULL`,
      );

      return 'created';
    } catch (error) {
      this.logger.warn(
        `Unable to create ${identifier}; native exact vector search remains available: ${errorMessage(error)}`,
      );
      return 'exact-only';
    }
  }

  protected async executeStatement(
    statement: string,
  ): Promise<{ rows: readonly Record<string, unknown>[] }> {
    return sql<Record<string, unknown>>`${sql.raw(statement)}`.execute(this.db);
  }
}

function validateInput(input: { profile: string; dimensions: number }): void {
  if (!PROFILE_PATTERN.test(input.profile)) {
    throw new Error('Embedding profile must be a lowercase SHA-256 digest');
  }
  if (!Number.isInteger(input.dimensions) || input.dimensions <= 0) {
    throw new Error('Embedding dimensions must be a positive integer');
  }
}

function indexIdentifier(input: {
  profile: string;
  dimensions: number;
}): string {
  return `idx_kc_hnsw_${input.profile.slice(0, 12)}_${input.dimensions}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
