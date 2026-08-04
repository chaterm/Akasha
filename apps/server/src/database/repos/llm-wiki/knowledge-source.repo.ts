import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { dbOrTx } from '@akasha/db/utils';
import {
  InsertableKnowledgeSource,
  InsertableKnowledgeSourceChunk,
  KnowledgeSource,
  KnowledgeSourceChunk,
} from '@akasha/db/types/entity.types';

type UpsertPageSourceInput = Pick<
  InsertableKnowledgeSource,
  | 'workspaceId'
  | 'sourcePageId'
  | 'sourceSpaceId'
  | 'sourceType'
  | 'sourceVersion'
  | 'contentHash'
> &
  Partial<
    Pick<
      InsertableKnowledgeSource,
      'attachmentId' | 'extractedText' | 'mimeType'
    >
  >;

type ReplaceSourceChunksInput = {
  workspaceId: string;
  sourceId: string;
  sourcePageId: string;
  chunks: Array<
    Pick<
      InsertableKnowledgeSourceChunk,
      'id' | 'text' | 'contentHash' | 'sourceRange' | 'quoteHash'
    >
  >;
};

@Injectable()
export class KnowledgeSourceRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async upsertPageSource(
    input: UpsertPageSourceInput,
    trx?: KyselyTransaction,
  ): Promise<KnowledgeSource> {
    const source = {
      ...input,
      attachmentId: input.attachmentId ?? null,
      extractedText: input.extractedText ?? null,
      mimeType: input.mimeType ?? null,
      staleAt: null,
      deletedAt: null,
    };

    return dbOrTx(this.db, trx)
      .insertInto('knowledgeSources')
      .values(source)
      .onConflict((oc) =>
        oc
          .columns(['workspaceId', 'sourcePageId', 'sourceVersion'])
          .doUpdateSet({
            sourceSpaceId: input.sourceSpaceId,
            sourceType: input.sourceType,
            attachmentId: input.attachmentId ?? null,
            contentHash: input.contentHash,
            extractedText: input.extractedText ?? null,
            mimeType: input.mimeType ?? null,
            staleAt: null,
            deletedAt: null,
            updatedAt: new Date(),
          }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async replaceSourceChunks(
    input: ReplaceSourceChunksInput,
    trx: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .deleteFrom('knowledgeSourceChunks')
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .execute();

    if (input.chunks.length === 0) return;

    await db
      .insertInto('knowledgeSourceChunks')
      .values(
        input.chunks.map((chunk) => ({
          ...chunk,
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          sourcePageId: input.sourcePageId,
        })),
      )
      .execute();
  }

  async findSourceChunksByPageIds(input: {
    workspaceId: string;
    sourcePageIds: string[];
    limit?: number;
  }): Promise<KnowledgeSourceChunk[]> {
    if (input.sourcePageIds.length === 0) return [];

    return this.db
      .selectFrom('knowledgeSourceChunks as chunk')
      .innerJoin('knowledgeSources as source', (join) =>
        join
          .onRef('source.id', '=', 'chunk.sourceId')
          .onRef('source.workspaceId', '=', 'chunk.workspaceId'),
      )
      .selectAll('chunk')
      .where('chunk.workspaceId', '=', input.workspaceId)
      .where('chunk.sourcePageId', 'in', input.sourcePageIds)
      .where('source.staleAt', 'is', null)
      .where('source.deletedAt', 'is', null)
      .orderBy('chunk.createdAt', 'desc')
      .limit(Math.min(Math.max(input.limit ?? 200, 1), 500))
      .execute();
  }

  async findActiveSourceTextsByPageIds(input: {
    workspaceId: string;
    sourcePageIds: string[];
  }): Promise<Array<{ sourcePageId: string; extractedText: string }>> {
    if (input.sourcePageIds.length === 0) return [];

    const rows = await this.db
      .selectFrom('knowledgeSources')
      .select(['sourcePageId', 'extractedText', 'updatedAt'])
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', 'in', input.sourcePageIds)
      .where('staleAt', 'is', null)
      .where('deletedAt', 'is', null)
      .where('extractedText', 'is not', null)
      .orderBy('updatedAt', 'desc')
      .execute();

    const seen = new Set<string>();
    return rows.flatMap((row) => {
      if (seen.has(row.sourcePageId) || row.extractedText === null) return [];
      seen.add(row.sourcePageId);
      return [
        {
          sourcePageId: row.sourcePageId,
          extractedText: row.extractedText,
        },
      ];
    });
  }

  async findLatestActiveSourceByPageId(input: {
    workspaceId: string;
    sourcePageId: string;
  }): Promise<KnowledgeSource | undefined> {
    return this.db
      .selectFrom('knowledgeSources')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .where('staleAt', 'is', null)
      .where('deletedAt', 'is', null)
      .orderBy('updatedAt', 'desc')
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();
  }

  async markSourcesStale(
    input: { workspaceId: string; sourcePageIds: string[] },
    trx?: KyselyTransaction,
  ): Promise<void> {
    if (input.sourcePageIds.length === 0) return;

    await dbOrTx(this.db, trx)
      .updateTable('knowledgeSources')
      .set({ staleAt: new Date() })
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', 'in', input.sourcePageIds)
      .execute();
  }

  async markSpaceSourcesStale(
    input: {
      workspaceId: string;
      spaceId: string;
      sourcePageIds: string[];
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    if (input.sourcePageIds.length === 0) return;
    await dbOrTx(this.db, trx)
      .updateTable('knowledgeSources')
      .set({ staleAt: new Date() })
      .where('workspaceId', '=', input.workspaceId)
      .where('sourceSpaceId', '=', input.spaceId)
      .where('sourcePageId', 'in', input.sourcePageIds)
      .where('deletedAt', 'is', null)
      .execute();
  }

  async findSourcesBySpace(
    input: { workspaceId: string; spaceId: string },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeSource[]> {
    return dbOrTx(this.db, trx)
      .selectFrom('knowledgeSources')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('sourceSpaceId', '=', input.spaceId)
      .where('deletedAt', 'is', null)
      .execute();
  }

  async findSourcePageIdsBySpaceBatch(input: {
    workspaceId: string;
    spaceId: string;
    afterSourcePageId?: string;
    limit: number;
  }): Promise<string[]> {
    const rows = await this.db
      .selectFrom('knowledgeSources')
      .select('sourcePageId')
      .distinct()
      .where('workspaceId', '=', input.workspaceId)
      .where('sourceSpaceId', '=', input.spaceId)
      .where('deletedAt', 'is', null)
      .$if(Boolean(input.afterSourcePageId), (query) =>
        query.where('sourcePageId', '>', input.afterSourcePageId!),
      )
      .orderBy('sourcePageId', 'asc')
      .limit(input.limit)
      .execute();
    return rows.map((row) => row.sourcePageId);
  }

  async findActiveSourcePageIdsBySpace(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<string[]> {
    const rows = await this.db
      .selectFrom('knowledgeSources')
      .select('sourcePageId')
      .distinct()
      .where('workspaceId', '=', input.workspaceId)
      .where('sourceSpaceId', '=', input.spaceId)
      .where('staleAt', 'is', null)
      .where('deletedAt', 'is', null)
      .execute();
    return rows.map((row) => row.sourcePageId);
  }
}
