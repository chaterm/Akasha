import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { JsonValue } from '@akasha/db/types/db';
import {
  KnowledgeReviewApplication,
  InsertableKnowledgeReviewApplication,
  UpdatableKnowledgeReviewApplication,
} from '@akasha/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { dbOrTx } from '@akasha/db/utils';

@Injectable()
export class KnowledgeReviewApplicationRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findById(
    input: { workspaceId: string; id: string },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeReviewApplication | null> {
    return (
      (await dbOrTx(this.db, trx)
        .selectFrom('knowledgeReviewApplications')
        .selectAll()
        .where('workspaceId', '=', input.workspaceId)
        .where('id', '=', input.id)
        .executeTakeFirst()) ?? null
    );
  }

  async findBySpace(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<KnowledgeReviewApplication[]> {
    return this.db
      .selectFrom('knowledgeReviewApplications')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .orderBy('updatedAt', 'desc')
      .execute();
  }

  async findLatestByReviewItem(input: {
    workspaceId: string;
    spaceId: string;
    reviewItemId: string;
  }): Promise<KnowledgeReviewApplication | null> {
    return (
      (await this.db
        .selectFrom('knowledgeReviewApplications')
        .selectAll()
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .where('reviewItemId', '=', input.reviewItemId)
        .orderBy('updatedAt', 'desc')
        .executeTakeFirst()) ?? null
    );
  }

  async insertApplication(
    input: Omit<
      InsertableKnowledgeReviewApplication,
      'id' | 'createdAt' | 'updatedAt'
    >,
    trx?: KyselyTransaction,
  ): Promise<KnowledgeReviewApplication> {
    return dbOrTx(this.db, trx)
      .insertInto('knowledgeReviewApplications')
      .values({
        ...input,
        targetHeadingPath: input.targetHeadingPath as JsonValue,
        patch: input.patch as JsonValue,
        sourceRefs: input.sourceRefs as JsonValue,
        updatedAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async updateApplication(
    input: {
      workspaceId: string;
      id: string;
      patch: UpdatableKnowledgeReviewApplication;
    },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeReviewApplication> {
    const patch = {
      ...input.patch,
      updatedAt: new Date(),
    };

    if (input.patch.targetHeadingPath !== undefined) {
      patch.targetHeadingPath = input.patch.targetHeadingPath as JsonValue;
    }
    if (input.patch.patch !== undefined) {
      patch.patch = input.patch.patch as JsonValue;
    }
    if (input.patch.sourceRefs !== undefined) {
      patch.sourceRefs = input.patch.sourceRefs as JsonValue;
    }

    return dbOrTx(this.db, trx)
      .updateTable('knowledgeReviewApplications')
      .set(patch)
      .where('workspaceId', '=', input.workspaceId)
      .where('id', '=', input.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async supersedeDraftsForReviewItem(input: {
    workspaceId: string;
    spaceId: string;
    reviewItemId: string;
  }): Promise<number> {
    const result = await this.db
      .updateTable('knowledgeReviewApplications')
      .set({
        status: 'superseded',
        updatedAt: new Date(),
      })
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .where('reviewItemId', '=', input.reviewItemId)
      .where('status', '=', 'draft')
      .executeTakeFirst();

    return Number(result.numUpdatedRows ?? 0);
  }
}
