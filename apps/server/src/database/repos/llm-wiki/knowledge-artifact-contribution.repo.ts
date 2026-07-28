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

  async findSpaceSourcePageIds(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<string[]> {
    const rows = await this.db
      .selectFrom('knowledgeArtifactContributions')
      .select('sourcePageId')
      .distinct()
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .orderBy('sourcePageId', 'asc')
      .execute();
    return rows.map((row) => row.sourcePageId);
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

  async findRemainingSourcePageIdsForRemovedSources(input: {
    workspaceId: string;
    spaceId: string;
    removedSourcePageIds: string[];
  }): Promise<string[]> {
    if (input.removedSourcePageIds.length === 0) return [];
    const rows = await this.db
      .selectFrom('knowledgeArtifactContributions as removed')
      .innerJoin('knowledgeArtifactContributions as remaining', (join) =>
        join
          .onRef('remaining.workspaceId', '=', 'removed.workspaceId')
          .onRef('remaining.spaceId', '=', 'removed.spaceId')
          .onRef('remaining.artifactId', '=', 'removed.artifactId'),
      )
      .select('remaining.sourcePageId')
      .distinct()
      .where('removed.workspaceId', '=', input.workspaceId)
      .where('removed.spaceId', '=', input.spaceId)
      .where('removed.sourcePageId', 'in', input.removedSourcePageIds)
      .where('remaining.sourcePageId', 'not in', input.removedSourcePageIds)
      .execute();
    return rows.map((row) => row.sourcePageId);
  }

  async deleteSpaceSourceContributions(
    input: {
      workspaceId: string;
      spaceId: string;
      sourcePageIds: string[];
    },
    trx: KyselyTransaction,
  ): Promise<{ orphanedArtifactIds: string[] }> {
    if (input.sourcePageIds.length === 0) {
      return { orphanedArtifactIds: [] };
    }
    const db = dbOrTx(this.db, trx);
    const affected = await db
      .selectFrom('knowledgeArtifactContributions')
      .select('artifactId')
      .distinct()
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .where('sourcePageId', 'in', input.sourcePageIds)
      .execute();
    const affectedArtifactIds = affected.map((row) => row.artifactId);
    await db
      .deleteFrom('knowledgeArtifactContributions')
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .where('sourcePageId', 'in', input.sourcePageIds)
      .execute();
    if (affectedArtifactIds.length === 0) {
      return { orphanedArtifactIds: [] };
    }
    const remaining = await db
      .selectFrom('knowledgeArtifactContributions')
      .select('artifactId')
      .distinct()
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .where('artifactId', 'in', affectedArtifactIds)
      .execute();
    const remainingIds = new Set(remaining.map((row) => row.artifactId));
    return {
      orphanedArtifactIds: affectedArtifactIds.filter(
        (artifactId) => !remainingIds.has(artifactId),
      ),
    };
  }
}
