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
    const sources = await this.sourceRepo.findSourcesBySpace(input);
    const sourcePageIds = unique(
      sources.map((source) => source.sourcePageId).filter(Boolean),
    );

    if (sourcePageIds.length === 0) {
      return {
        scannedCount: 0,
        driftCount: 0,
        repairedCount: 0,
      };
    }

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

    if (driftedSourcePageIds.length === 0) {
      return {
        scannedCount: sourcePageIds.length,
        driftCount: 0,
        repairedCount: 0,
      };
    }

    const repairResult = await this.accessIndexer.reindexSourcePages({
      workspaceId: input.workspaceId,
      sourcePageIds: driftedSourcePageIds,
    });

    return {
      scannedCount: sourcePageIds.length,
      driftCount: driftedSourcePageIds.length,
      repairedCount: repairResult.indexedCount,
    };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
