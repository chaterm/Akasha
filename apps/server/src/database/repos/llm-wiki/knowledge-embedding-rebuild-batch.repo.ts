import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { dbOrTx } from '@akasha/db/utils';

export type KnowledgeEmbeddingRebuildBatchInput = {
  workspaceId: string;
  spaceId: string;
  chunkCount: number;
  failedCount: number;
  totalTokens: number | null;
  durationMs: number;
  embeddingProfile: string | null;
  embeddingModel: string | null;
};

export type KnowledgeEmbeddingRebuildUsageSummary = {
  batchCount: number;
  chunkCount: number;
  failedCount: number;
  totalTokens: number | null;
  durationMs: number;
  firstBatchAt: Date | null;
  lastBatchAt: Date | null;
};

@Injectable()
export class KnowledgeEmbeddingRebuildBatchRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async recordBatch(
    input: KnowledgeEmbeddingRebuildBatchInput,
    trx?: KyselyTransaction,
  ): Promise<void> {
    await dbOrTx(this.db, trx)
      .insertInto('knowledgeEmbeddingRebuildBatches')
      .values({
        workspaceId: input.workspaceId,
        spaceId: input.spaceId,
        chunkCount: input.chunkCount,
        failedCount: input.failedCount,
        totalTokens: input.totalTokens,
        durationMs: input.durationMs,
        embeddingProfile: input.embeddingProfile,
        embeddingModel: input.embeddingModel,
      })
      .execute();
  }

  async summarizeSpaces(input: {
    workspaceId: string;
    spaceIds: string[];
    since?: Date;
  }): Promise<KnowledgeEmbeddingRebuildUsageSummary> {
    if (input.spaceIds.length === 0) return emptySummary();

    const row = await this.db
      .selectFrom('knowledgeEmbeddingRebuildBatches')
      .select((eb) => [
        eb.fn.countAll<string>().as('batchCount'),
        eb.fn.sum<string | null>('chunkCount').as('chunkCount'),
        eb.fn.sum<string | null>('failedCount').as('failedCount'),
        eb.fn.sum<string | null>('totalTokens').as('totalTokens'),
        eb.fn.sum<string | null>('durationMs').as('durationMs'),
        eb.fn.min<Date | null>('createdAt').as('firstBatchAt'),
        eb.fn.max<Date | null>('createdAt').as('lastBatchAt'),
      ])
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', 'in', input.spaceIds)
      .$if(Boolean(input.since), (query) =>
        query.where('createdAt', '>=', input.since!),
      )
      .executeTakeFirst();

    if (!row) return emptySummary();

    return {
      batchCount: numberValue(row.batchCount),
      chunkCount: numberValue(row.chunkCount),
      failedCount: numberValue(row.failedCount),
      totalTokens:
        row.totalTokens === null ? null : numberValue(row.totalTokens),
      durationMs: numberValue(row.durationMs),
      firstBatchAt: row.firstBatchAt ?? null,
      lastBatchAt: row.lastBatchAt ?? null,
    };
  }
}

function emptySummary(): KnowledgeEmbeddingRebuildUsageSummary {
  return {
    batchCount: 0,
    chunkCount: 0,
    failedCount: 0,
    totalTokens: null,
    durationMs: 0,
    firstBatchAt: null,
    lastBatchAt: null,
  };
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}
