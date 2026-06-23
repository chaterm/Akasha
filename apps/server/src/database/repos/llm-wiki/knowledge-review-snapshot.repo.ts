import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { JsonValue } from '@docmost/db/types/db';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';
import { KnowledgeReviewSnapshot } from '@docmost/db/types/entity.types';

type UpsertKnowledgeReviewSnapshotInput = {
  workspaceId: string;
  spaceId: string;
  version: string;
  items: unknown;
  docs: unknown;
  resolvedReviews: unknown;
  discoveredAt: Date;
};

@Injectable()
export class KnowledgeReviewSnapshotRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findBySpace(
    input: { workspaceId: string; spaceId: string },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeReviewSnapshot | null> {
    return (
      (await dbOrTx(this.db, trx)
        .selectFrom('knowledgeReviewSnapshots')
        .selectAll()
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .executeTakeFirst()) ?? null
    );
  }

  async upsertSnapshot(
    input: UpsertKnowledgeReviewSnapshotInput,
    trx?: KyselyTransaction,
  ): Promise<KnowledgeReviewSnapshot> {
    const row = {
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      version: input.version,
      items: input.items as JsonValue,
      docs: input.docs as JsonValue,
      resolvedReviews: input.resolvedReviews as JsonValue,
      discoveredAt: input.discoveredAt,
      updatedAt: new Date(),
    };

    return dbOrTx(this.db, trx)
      .insertInto('knowledgeReviewSnapshots')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['workspaceId', 'spaceId']).doUpdateSet({
          version: input.version,
          items: input.items as JsonValue,
          docs: input.docs as JsonValue,
          resolvedReviews: input.resolvedReviews as JsonValue,
          discoveredAt: input.discoveredAt,
          updatedAt: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
