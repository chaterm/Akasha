import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
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
    input: { workspaceId: string; sourcePageId: string; spaceId?: string },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeArtifactContribution[]> {
    return dbOrTx(this.db, trx)
      .selectFrom('knowledgeArtifactContributions')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .$if(Boolean(input.spaceId), (query) =>
        query.where('spaceId', '=', input.spaceId!),
      )
      .orderBy('artifactId', 'asc')
      .execute();
  }

  async findByArtifactIds(
    input: { workspaceId: string; artifactIds: string[]; spaceId?: string },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeArtifactContribution[]> {
    if (input.artifactIds.length === 0) return [];
    return dbOrTx(this.db, trx)
      .selectFrom('knowledgeArtifactContributions')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('artifactId', 'in', input.artifactIds)
      .$if(Boolean(input.spaceId), (query) =>
        query.where('spaceId', '=', input.spaceId!),
      )
      .orderBy('sourcePageId', 'asc')
      .execute();
  }

  async findSourceScopes(input: {
    workspaceId: string;
    sourcePageIds: string[];
  }): Promise<Array<{ sourcePageId: string; spaceId: string }>> {
    if (input.sourcePageIds.length === 0) return [];
    return this.db
      .selectFrom('knowledgeArtifactContributions')
      .select(['sourcePageId', 'spaceId'])
      .distinct()
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', 'in', input.sourcePageIds)
      .orderBy('spaceId', 'asc')
      .orderBy('sourcePageId', 'asc')
      .execute();
  }

  /**
   * Title each source gave its own contribution to an artifact. Used when a
   * reader cannot see every source of the merged artifact and must not see its
   * merged title. Reads only the title field, not the whole payload.
   */
  async findContributionTitles(input: {
    workspaceId: string;
    pairs: Array<{ artifactId: string; sourcePageId: string }>;
  }): Promise<
    Array<{ artifactId: string; sourcePageId: string; title: string | null }>
  > {
    if (input.pairs.length === 0) return [];
    const rows = await this.db
      .selectFrom('knowledgeArtifactContributions')
      .select([
        'artifactId',
        'sourcePageId',
        sql<string | null>`artifact ->> 'title'`.as('title'),
      ])
      .where('workspaceId', '=', input.workspaceId)
      .where('artifactId', 'in', [
        ...new Set(input.pairs.map((pair) => pair.artifactId)),
      ])
      .where('sourcePageId', 'in', [
        ...new Set(input.pairs.map((pair) => pair.sourcePageId)),
      ])
      .execute();
    return rows;
  }

  async replaceSourceContributions(
    input: {
      workspaceId: string;
      spaceId: string;
      sourcePageId: string;
      contributions: ReplaceKnowledgeContributionInput[];
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .deleteFrom('knowledgeArtifactContributions')
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
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
