import { Injectable } from '@nestjs/common';
import { KnowledgeAccessPolicyRepo } from '@akasha/db/repos/llm-wiki/knowledge-access-policy.repo';
import { KnowledgeSourceRepo } from '@akasha/db/repos/llm-wiki/knowledge-source.repo';
import { KnowledgeAccessIndexerService } from './knowledge-access-indexer.service';

export type KnowledgeAccessRepairResult = {
  scannedCount: number;
  driftCount: number;
  repairedCount: number;
};

@Injectable()
export class KnowledgeAccessRepairService {
  constructor(
    private readonly sourceRepo: KnowledgeSourceRepo,
    private readonly accessPolicyRepo: KnowledgeAccessPolicyRepo,
    private readonly accessIndexer: KnowledgeAccessIndexerService,
  ) {}

  async repairSpace(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<KnowledgeAccessRepairResult> {
    let scannedCount = 0;
    let driftCount = 0;
    let repairedCount = 0;
    let afterSourcePageId: string | undefined;

    do {
      const sourcePageIds = await this.sourceRepo.findSourcePageIdsBySpaceBatch(
        {
          ...input,
          ...(afterSourcePageId ? { afterSourcePageId } : {}),
          limit: 200,
        },
      );
      if (sourcePageIds.length === 0) break;
      scannedCount += sourcePageIds.length;

      const [computedSnapshots, storedPolicies] = await Promise.all([
        this.accessIndexer.computePolicySnapshots({
          workspaceId: input.workspaceId,
          sourcePageIds,
        }),
        this.accessPolicyRepo.findPoliciesForSources({
          workspaceId: input.workspaceId,
          sourcePageIds,
        }),
      ]);
      const storedBySourcePageId = new Map(
        storedPolicies.map((policy) => [policy.sourcePageId, policy]),
      );
      const driftedSourcePageIds = computedSnapshots
        .filter((snapshot) => {
          const stored = storedBySourcePageId.get(snapshot.sourcePageId);
          return (
            !stored ||
            stored.staleAt !== null ||
            stored.policyHash !== snapshot.policyHash ||
            stored.restrictedAncestorCount !== snapshot.restrictedAncestorCount
          );
        })
        .map((snapshot) => snapshot.sourcePageId);

      driftCount += driftedSourcePageIds.length;
      if (driftedSourcePageIds.length > 0) {
        const repairResult = await this.accessIndexer.reindexSourcePages({
          workspaceId: input.workspaceId,
          sourcePageIds: driftedSourcePageIds,
        });
        repairedCount += repairResult.indexedCount;
      }
      afterSourcePageId =
        sourcePageIds.length === 200
          ? sourcePageIds[sourcePageIds.length - 1]
          : undefined;
    } while (afterSourcePageId);

    return { scannedCount, driftCount, repairedCount };
  }
}
