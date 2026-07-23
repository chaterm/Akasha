import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { KnowledgeAccessPolicyRepo } from '@akasha/db/repos/llm-wiki/knowledge-access-policy.repo';
import { PagePermissionRepo } from '@akasha/db/repos/page/page-permission.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { SourcePageRestrictedAncestorRequirements } from '@akasha/db/repos/page/types/page-permission.types';

type IndexedRequirement = {
  requirementId: string;
  restrictedPageId: string;
  depth: number;
  principals: Array<{
    principalType: string;
    principalId: string;
    role: string;
  }>;
};

export type KnowledgeAccessPolicySnapshot = {
  workspaceId: string;
  sourcePageId: string;
  sourceSpaceId: string;
  policyHash: string;
  restrictedAncestorCount: number;
  requirements: IndexedRequirement[];
};

@Injectable()
export class KnowledgeAccessIndexerService {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly accessPolicyRepo: KnowledgeAccessPolicyRepo,
  ) {}

  async reindexSourcePages(input: {
    workspaceId: string;
    sourcePageIds: string[];
  }): Promise<{ indexedCount: number }> {
    const snapshots = await this.computePolicySnapshots(input);

    for (const snapshot of snapshots) {
      await this.accessPolicyRepo.replacePolicySnapshot(snapshot);
    }

    return { indexedCount: snapshots.length };
  }

  async computePolicySnapshots(input: {
    workspaceId: string;
    sourcePageIds: string[];
  }): Promise<KnowledgeAccessPolicySnapshot[]> {
    if (input.sourcePageIds.length === 0) {
      return [];
    }

    const pageRefs = await this.pageRepo.findExistingPageRefs({
      workspaceId: input.workspaceId,
      pageIds: input.sourcePageIds,
    });
    const livePageRefs = pageRefs.filter((page) => page.deletedAt === null);
    if (livePageRefs.length === 0) {
      return [];
    }

    const livePageIds = livePageRefs.map((page) => page.id);
    const requirements =
      await this.pagePermissionRepo.findRestrictedAncestorRequirementsForPages(
        livePageIds,
      );
    const requirementsBySource = new Map(
      requirements.map((requirement) => [requirement.sourcePageId, requirement]),
    );

    return livePageRefs.map((page) => {
      const sourceRequirements = requirementsBySource.get(page.id);
      const indexedRequirements = toIndexedRequirements(sourceRequirements);

      return {
        workspaceId: input.workspaceId,
        sourcePageId: page.id,
        sourceSpaceId: sourceRequirements?.sourceSpaceId ?? page.spaceId,
        policyHash: hashPolicy(indexedRequirements),
        restrictedAncestorCount: indexedRequirements.length,
        requirements: indexedRequirements,
      };
    });
  }

  async markScopeStale(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<void> {
    await this.accessPolicyRepo.markScopeStale(input);
  }
}

function toIndexedRequirements(
  sourceRequirements: SourcePageRestrictedAncestorRequirements | undefined,
): IndexedRequirement[] {
  return [...(sourceRequirements?.restrictedAncestors ?? [])]
    .sort(compareRequirements)
    .map((requirement) => ({
      requirementId: requirement.pageAccessId,
      restrictedPageId: requirement.restrictedPageId,
      depth: requirement.depth,
      principals: requirement.permissions
        .flatMap((permission) => {
          if (permission.userId) {
            return [
              {
                principalType: 'user',
                principalId: permission.userId,
                role: permission.role,
              },
            ];
          }
          if (permission.groupId) {
            return [
              {
                principalType: 'group',
                principalId: permission.groupId,
                role: permission.role,
              },
            ];
          }
          return [];
        })
        .sort(comparePrincipals),
    }));
}

function compareRequirements(
  a: SourcePageRestrictedAncestorRequirements['restrictedAncestors'][number],
  b: SourcePageRestrictedAncestorRequirements['restrictedAncestors'][number],
): number {
  return (
    a.depth - b.depth ||
    a.restrictedPageId.localeCompare(b.restrictedPageId) ||
    a.pageAccessId.localeCompare(b.pageAccessId)
  );
}

function comparePrincipals(
  a: IndexedRequirement['principals'][number],
  b: IndexedRequirement['principals'][number],
): number {
  return (
    a.principalType.localeCompare(b.principalType) ||
    a.principalId.localeCompare(b.principalId) ||
    a.role.localeCompare(b.role)
  );
}

function hashPolicy(requirements: IndexedRequirement[]): string {
  const canonical = JSON.stringify(requirements);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
