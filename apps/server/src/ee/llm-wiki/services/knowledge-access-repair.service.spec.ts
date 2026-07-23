import { KnowledgeAccessPolicyRepo } from '@akasha/db/repos/llm-wiki/knowledge-access-policy.repo';
import { KnowledgeSourceRepo } from '@akasha/db/repos/llm-wiki/knowledge-source.repo';
import {
  KnowledgeAccessIndexerService,
  KnowledgeAccessPolicySnapshot,
} from './knowledge-access-indexer.service';
import { KnowledgeAccessRepairService } from './knowledge-access-repair.service';

describe('KnowledgeAccessRepairService', () => {
  it('repairs only sources whose stored policy is missing, stale, or hash-drifted', async () => {
    const accessIndexer = {
      computePolicySnapshots: jest.fn().mockResolvedValue([
        snapshot('source-1', 'hash-current-1'),
        snapshot('source-2', 'hash-current-2'),
        snapshot('source-3', 'hash-current-3'),
        snapshot('source-4', 'hash-current-4'),
      ]),
      reindexSourcePages: jest.fn().mockResolvedValue({ indexedCount: 3 }),
    };
    const service = createService({
      accessIndexer,
      sources: [
        source('source-1'),
        source('source-2'),
        source('source-3'),
        source('source-4'),
      ],
      policies: [
        policy('source-1', 'hash-current-1', null),
        policy('source-2', 'hash-old', null),
        policy('source-3', 'hash-current-3', new Date('2026-06-16T00:00:00Z')),
      ],
    });

    await expect(
      service.repairSpace({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({
      scannedCount: 4,
      driftCount: 3,
      repairedCount: 3,
    });

    expect(accessIndexer.computePolicySnapshots).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['source-1', 'source-2', 'source-3', 'source-4'],
    });
    expect(accessIndexer.reindexSourcePages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['source-2', 'source-3', 'source-4'],
    });
  });

  it('does not reindex when no drift is found', async () => {
    const accessIndexer = {
      computePolicySnapshots: jest
        .fn()
        .mockResolvedValue([snapshot('source-1', 'hash-current')]),
      reindexSourcePages: jest.fn(),
    };
    const service = createService({
      accessIndexer,
      sources: [source('source-1')],
      policies: [policy('source-1', 'hash-current', null)],
    });

    await expect(
      service.repairSpace({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({
      scannedCount: 1,
      driftCount: 0,
      repairedCount: 0,
    });

    expect(accessIndexer.reindexSourcePages).not.toHaveBeenCalled();
  });
});

function createService(overrides: {
  sources?: Array<{
    sourcePageId: string;
    workspaceId: string;
    sourceSpaceId: string;
  }>;
  policies?: Array<{
    sourcePageId: string;
    policyHash: string;
    restrictedAncestorCount: number;
    staleAt: Date | null;
  }>;
  accessIndexer?: Partial<KnowledgeAccessIndexerService>;
}) {
  const sourceRepo = {
    findSourcesBySpace: jest.fn().mockResolvedValue(overrides.sources ?? []),
  };
  const accessPolicyRepo = {
    findPoliciesForSources: jest.fn().mockResolvedValue(overrides.policies ?? []),
  };
  const accessIndexer = {
    computePolicySnapshots: jest.fn().mockResolvedValue([]),
    reindexSourcePages: jest.fn().mockResolvedValue({ indexedCount: 0 }),
    ...overrides.accessIndexer,
  };

  return new KnowledgeAccessRepairService(
    sourceRepo as unknown as KnowledgeSourceRepo,
    accessPolicyRepo as unknown as KnowledgeAccessPolicyRepo,
    accessIndexer as unknown as KnowledgeAccessIndexerService,
  );
}

function source(sourcePageId: string) {
  return {
    id: `row-${sourcePageId}`,
    workspaceId: 'workspace-1',
    sourcePageId,
    sourceSpaceId: 'space-1',
    sourceType: 'docmost_page',
    sourceVersion: 'v1',
    attachmentId: null,
    contentHash: `content-${sourcePageId}`,
    extractedText: null,
    mimeType: null,
    staleAt: null,
    deletedAt: null,
    createdAt: new Date('2026-06-16T00:00:00Z'),
    updatedAt: new Date('2026-06-16T00:00:00Z'),
  };
}

function policy(
  sourcePageId: string,
  policyHash: string,
  staleAt: Date | null,
) {
  return {
    id: `policy-${sourcePageId}`,
    workspaceId: 'workspace-1',
    sourcePageId,
    sourceSpaceId: 'space-1',
    policyHash,
    restrictedAncestorCount: 0,
    staleAt,
    createdAt: new Date('2026-06-16T00:00:00Z'),
    updatedAt: new Date('2026-06-16T00:00:00Z'),
  };
}

function snapshot(
  sourcePageId: string,
  policyHash: string,
): KnowledgeAccessPolicySnapshot {
  return {
    workspaceId: 'workspace-1',
    sourcePageId,
    sourceSpaceId: 'space-1',
    policyHash,
    restrictedAncestorCount: 0,
    requirements: [],
  };
}
