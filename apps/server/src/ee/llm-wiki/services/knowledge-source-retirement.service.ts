import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { InjectKysely } from 'nestjs-kysely';
import { KnowledgeArtifactContribution } from '@akasha/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { KnowledgeArtifactContributionRepo } from '@akasha/db/repos/llm-wiki/knowledge-artifact-contribution.repo';
import { KnowledgeImportService } from './knowledge-import.service';
import { KnowledgeLinkResolverService } from './knowledge-link-resolver.service';

const MAX_RETIREMENT_CAS_ATTEMPTS = 3;

export type KnowledgeSourceRetirementResult = {
  retiredSourceCount: number;
  skippedActiveSourceCount: number;
  affectedSpaceCount: number;
};

/**
 * Removes deleted or moved page contributions without invalidating surviving
 * canonical artifacts. Materialization and embedding happen outside the
 * publication transaction; the contribution snapshot is checked again by the
 * import publication guard before any source is retired.
 */
@Injectable()
export class KnowledgeSourceRetirementService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly contributionRepo: KnowledgeArtifactContributionRepo,
    private readonly importService: KnowledgeImportService,
    private readonly linkResolver: KnowledgeLinkResolverService,
  ) {}

  async retireOutOfScopeSources(input: {
    workspaceId: string;
    sourcePageIds: string[];
  }): Promise<KnowledgeSourceRetirementResult> {
    const sourcePageIds = [...new Set(input.sourcePageIds)].sort();
    if (sourcePageIds.length === 0) {
      return {
        retiredSourceCount: 0,
        skippedActiveSourceCount: 0,
        affectedSpaceCount: 0,
      };
    }

    const [scopes, livePages] = await Promise.all([
      this.contributionRepo.findSourceScopes({
        workspaceId: input.workspaceId,
        sourcePageIds,
      }),
      this.db
        .selectFrom('pages')
        .select(['id', 'spaceId', 'deletedAt'])
        .where('workspaceId', '=', input.workspaceId)
        .where('id', 'in', sourcePageIds)
        .execute(),
    ]);
    const liveSpaceByPageId = new Map(
      livePages
        .filter((page) => page.deletedAt === null)
        .map((page) => [page.id, page.spaceId]),
    );
    let retiredSourceCount = 0;
    let skippedActiveSourceCount = 0;
    const affectedSpaces = new Set<string>();

    for (const scope of scopes) {
      if (liveSpaceByPageId.get(scope.sourcePageId) === scope.spaceId) {
        skippedActiveSourceCount += 1;
        continue;
      }
      const retired = await this.retireSourceFromSpace({
        workspaceId: input.workspaceId,
        spaceId: scope.spaceId,
        sourcePageId: scope.sourcePageId,
      });
      if (retired) {
        retiredSourceCount += 1;
        affectedSpaces.add(scope.spaceId);
      }
    }

    for (const spaceId of affectedSpaces) {
      await this.linkResolver.resolveSpace({
        workspaceId: input.workspaceId,
        spaceId,
      });
    }

    return {
      retiredSourceCount,
      skippedActiveSourceCount,
      affectedSpaceCount: affectedSpaces.size,
    };
  }

  private async retireSourceFromSpace(input: {
    workspaceId: string;
    spaceId: string;
    sourcePageId: string;
  }): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_RETIREMENT_CAS_ATTEMPTS; attempt += 1) {
      if (await this.isSourceActiveInSpace(input)) return false;
      const previous = await this.contributionRepo.findBySourcePage(input);
      if (previous.length === 0) return false;
      const artifactIds = [...new Set(previous.map((row) => row.artifactId))];
      const affected = await this.contributionRepo.findByArtifactIds({
        workspaceId: input.workspaceId,
        spaceId: input.spaceId,
        artifactIds,
      });
      const expectedContributionHash = contributionSnapshotHash(affected);
      const representative = previous[0];
      const publication = await this.importService.importCompileResult({
        input: {
          workspaceId: input.workspaceId,
          spaceId: input.spaceId,
          compilerVersion: representative.compilerVersion,
          promptVersion: representative.promptVersion,
          compileTaskId: `retirement:${input.spaceId}:${input.sourcePageId}`,
          compileMode: 'pages',
          sources: [
            {
              workspaceId: input.workspaceId,
              spaceId: input.spaceId,
              sourcePageId: input.sourcePageId,
              sourceVersion: representative.sourceVersion,
              contentHash: representative.sourceContentHash,
              title: 'Retired source',
              text: '',
              references: [],
            },
          ],
        },
        artifacts: [],
        upsertSources: false,
        retireSources: true,
        publicationGuard: async (trx) =>
          this.matchesPublicationFence(
            input,
            artifactIds,
            expectedContributionHash,
            trx,
          ),
      });
      if (publication.skippedReason !== 'run_superseded') return true;
    }
    throw new Error(
      `Knowledge source retirement changed repeatedly for ${input.sourcePageId}.`,
    );
  }

  private async matchesPublicationFence(
    input: { workspaceId: string; spaceId: string; sourcePageId: string },
    artifactIds: string[],
    expectedContributionHash: string,
    trx: KyselyTransaction,
  ): Promise<boolean> {
    if (await this.isSourceActiveInSpace(input, trx)) return false;
    const current = await this.contributionRepo.findByArtifactIds(
      {
        workspaceId: input.workspaceId,
        spaceId: input.spaceId,
        artifactIds,
      },
      trx,
    );
    return contributionSnapshotHash(current) === expectedContributionHash;
  }

  private async isSourceActiveInSpace(
    input: { workspaceId: string; spaceId: string; sourcePageId: string },
    trx?: KyselyTransaction,
  ): Promise<boolean> {
    const db = trx ?? this.db;
    const page = await db
      .selectFrom('pages')
      .select('id')
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .where('id', '=', input.sourcePageId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    return Boolean(page);
  }
}

function contributionSnapshotHash(
  contributions: KnowledgeArtifactContribution[],
): string {
  const payload = contributions
    .map((contribution) => ({
      id: contribution.id,
      artifactId: contribution.artifactId,
      sourcePageId: contribution.sourcePageId,
      sourceVersion: contribution.sourceVersion,
      sourceContentHash: contribution.sourceContentHash,
      artifact: contribution.artifact,
    }))
    .sort((left, right) =>
      `${left.artifactId}:${left.sourcePageId}:${left.id}`.localeCompare(
        `${right.artifactId}:${right.sourcePageId}:${right.id}`,
      ),
    );
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
