import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { JsonValue } from '@akasha/db/types/db';
import {
  KnowledgeArtifactContribution,
  InsertableKnowledgeArtifactContribution,
} from '@akasha/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { dbOrTx } from '@akasha/db/utils';

export type ReplaceKnowledgeContributionInput = Omit<
  InsertableKnowledgeArtifactContribution,
  'artifact' | 'createdAt' | 'updatedAt'
> & {
  artifact: JsonValue;
};

@Injectable()
export class KnowledgeArtifactContributionRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findBySourcePage(
    input: { workspaceId: string; sourcePageId: string },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeArtifactContribution[]> {
    return dbOrTx(this.db, trx)
      .selectFrom('knowledgeArtifactContributions')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .orderBy('artifactId', 'asc')
      .execute();
  }

  async findByArtifactIds(
    input: { workspaceId: string; artifactIds: string[] },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeArtifactContribution[]> {
    if (input.artifactIds.length === 0) return [];
    return dbOrTx(this.db, trx)
      .selectFrom('knowledgeArtifactContributions')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('artifactId', 'in', input.artifactIds)
      .orderBy('sourcePageId', 'asc')
      .execute();
  }

  async replaceSourceContributions(
    input: {
      workspaceId: string;
      sourcePageId: string;
      contributions: ReplaceKnowledgeContributionInput[];
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .deleteFrom('knowledgeArtifactContributions')
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .execute();

    if (input.contributions.length === 0) return;
    const now = new Date();
    await db
      .insertInto('knowledgeArtifactContributions')
      .values(
        input.contributions.map((contribution) => ({
          ...contribution,
          artifact: contribution.artifact,
          updatedAt: now,
        })),
      )
      .execute();
  }
}
