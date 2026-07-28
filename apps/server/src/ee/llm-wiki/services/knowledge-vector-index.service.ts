import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { toSql as vectorToSql } from 'pgvector';
import {
  ConfiguredKnowledgeEmbeddingProvider,
  KnowledgeEmbedding,
} from './knowledge-embedding-provider.service';

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

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly embeddingProvider: ConfiguredKnowledgeEmbeddingProvider,
  ) {}

  async rebuildSpaceEmbeddings(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<{ rebuiltChunkCount: number }> {
    const chunks = await this.findActiveChunksForSpace(input);
    if (chunks.length === 0) return { rebuiltChunkCount: 0 };
    const rebuilt: Array<KnowledgeEmbedding & { id: string }> = [];

    for (const chunk of chunks) {
      const embedding = await this.embeddingProvider.embedQuery(
        embeddingInput(chunk),
      );
      if (!embedding) {
        throw new Error(
          `Unable to rebuild embedding for knowledge chunk ${chunk.id}`,
        );
      }
      rebuilt.push({ id: chunk.id, ...embedding });
    }

    await this.persistRebuiltEmbeddings({ ...input, chunks: rebuilt });

    const profiles = new Map<string, number>();
    for (const chunk of rebuilt) {
      profiles.set(chunk.profile, chunk.dimensions);
    }
    await Promise.all(
      [...profiles].map(([profile, dimensions]) =>
        this.ensureProfileIndex({ profile, dimensions }),
      ),
    );

    return { rebuiltChunkCount: rebuilt.length };
  }

  protected async findActiveChunksForSpace(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<Array<{ id: string; text: string; headingPath: unknown }>> {
    return this.db
      .selectFrom('knowledgeChunks')
      .select(['id', 'text', 'headingPath'])
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .where('staleAt', 'is', null)
      .orderBy('id', 'asc')
      .execute();
  }

  protected async persistRebuiltEmbeddings(input: {
    workspaceId: string;
    spaceId: string;
    chunks: Array<KnowledgeEmbedding & { id: string }>;
  }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      for (const chunk of input.chunks) {
        await trx
          .updateTable('knowledgeChunks')
          .set({
            embedding: vectorToSql(chunk.vector),
            embeddingLegacy: chunk.vector,
            embeddingProfile: chunk.profile,
            embeddingModel: chunk.model,
            embeddingDimensions: chunk.dimensions,
          })
          .where('id', '=', chunk.id)
          .where('workspaceId', '=', input.workspaceId)
          .where('spaceId', '=', input.spaceId)
          .where('staleAt', 'is', null)
          .execute();
      }
    });
  }

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
            AND stale_at IS NULL
            AND embedding IS NOT NULL`,
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

function embeddingInput(chunk: { text: string; headingPath: unknown }): string {
  const headingPath = Array.isArray(chunk.headingPath)
    ? chunk.headingPath.filter(
        (value): value is string => typeof value === 'string' && Boolean(value),
      )
    : [];
  return headingPath.length > 0
    ? `${headingPath.join(' > ')}\n\n${chunk.text}`
    : chunk.text;
}
