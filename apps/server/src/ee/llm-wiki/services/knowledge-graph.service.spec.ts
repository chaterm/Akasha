import { KnowledgeCapsuleRepo } from '@docmost/db/repos/llm-wiki/knowledge-capsule.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserRole } from '../../../common/helpers/types/permission';
import { SpaceAuthorizationService } from '../../../core/space/services/space-authorization.service';
import { KnowledgeSourceAuthorizationService } from './knowledge-source-authorization.service';
import { KnowledgeGraphService } from './knowledge-graph.service';

describe('KnowledgeGraphService', () => {
  it('returns only graph nodes and edges whose source lineage is readable', async () => {
    const capsuleRepo = {
      findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
        pages: [
          page('kp-1', 'Kafka'),
          page('kp-2', 'Chaterm'),
          page('kp-hidden', 'Hidden'),
        ],
        pageSources: [
          pageSource('kp-1', 'source-1'),
          pageSource('kp-2', 'source-2'),
          pageSource('kp-hidden', 'source-hidden'),
        ],
        links: [
          link('link-1', 'kp-1', 'kp-2', 'references'),
          link('link-hidden', 'kp-1', 'kp-hidden', 'private'),
        ],
        linkSources: [
          linkSource('link-1', 'source-1'),
          linkSource('link-1', 'source-2'),
          linkSource('link-hidden', 'source-hidden'),
        ],
        graphEdges: [graphEdge('edge-1', 'kp-2', 'kp-1', 'depends on')],
        graphEdgeSources: [
          graphEdgeSource('edge-1', 'source-1'),
          graphEdgeSource('edge-1', 'source-2'),
        ],
      }),
    };
    const sourceAuthorization = {
      filterReadableSources: jest
        .fn()
        .mockResolvedValue(['source-1', 'source-2']),
    };
    const service = createService({ capsuleRepo, sourceAuthorization });

    await expect(
      service.getSpaceGraph({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({
      nodes: [
        {
          id: 'kp-1',
          title: 'Kafka',
          spaceId: 'space-1',
          sourcePageId: 'source-1',
          degree: 2,
          artifactKind: 'source_summary',
          communityId: 'community-1',
        },
        {
          id: 'kp-2',
          title: 'Chaterm',
          spaceId: 'space-1',
          sourcePageId: 'source-2',
          degree: 2,
          artifactKind: 'source_summary',
          communityId: 'community-1',
        },
      ],
      edges: [
        {
          id: 'link-1',
          from: 'kp-1',
          to: 'kp-2',
          type: 'link',
          label: 'references',
          weight: 3,
          reasons: ['direct-link'],
        },
        {
          id: 'edge-1',
          from: 'kp-2',
          to: 'kp-1',
          type: 'semantic',
          label: 'depends on',
          weight: 2,
          reasons: ['semantic-edge'],
        },
      ],
      insights: {
        isolatedNodeIds: [],
        bridgeNodeIds: ['kp-1', 'kp-2'],
        communityCount: 1,
      },
    });

    expect(capsuleRepo.findGraphCandidatesForSpace).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      limit: 300,
    });
    expect(sourceAuthorization.filterReadableSources).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      sourcePageIds: ['source-1', 'source-2', 'source-hidden'],
    });
  });

  it('does not query graph candidates when the user cannot read the space', async () => {
    const capsuleRepo = {
      findGraphCandidatesForSpace: jest.fn(),
    };
    const service = createService({
      capsuleRepo,
      spaceAuthorization: {
        filterReadableSpaceIds: jest.fn().mockResolvedValue([]),
      },
    });

    await expect(
      service.getSpaceGraph({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({
      nodes: [],
      edges: [],
      insights: {
        isolatedNodeIds: [],
        bridgeNodeIds: [],
        communityCount: 0,
      },
    });

    expect(capsuleRepo.findGraphCandidatesForSpace).not.toHaveBeenCalled();
  });
});

function createService(
  overrides: {
    userRepo?: Partial<UserRepo>;
    capsuleRepo?: Record<string, unknown>;
    sourceAuthorization?: Partial<KnowledgeSourceAuthorizationService>;
    spaceAuthorization?: Partial<SpaceAuthorizationService>;
  } = {},
) {
  const userRepo = {
    findById: jest.fn().mockResolvedValue({
      id: 'user-1',
      workspaceId: 'workspace-1',
      role: UserRole.MEMBER,
    }),
    ...overrides.userRepo,
  };
  const capsuleRepo = {
    findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
      pages: [],
      pageSources: [],
      links: [],
      linkSources: [],
      graphEdges: [],
      graphEdgeSources: [],
    }),
    ...overrides.capsuleRepo,
  };
  const sourceAuthorization = {
    filterReadableSources: jest.fn().mockResolvedValue([]),
    ...overrides.sourceAuthorization,
  };
  const spaceAuthorization = {
    filterReadableSpaceIds: jest.fn().mockResolvedValue(['space-1']),
    ...overrides.spaceAuthorization,
  };

  return new KnowledgeGraphService(
    userRepo as unknown as UserRepo,
    spaceAuthorization as unknown as SpaceAuthorizationService,
    capsuleRepo as unknown as KnowledgeCapsuleRepo,
    sourceAuthorization as unknown as KnowledgeSourceAuthorizationService,
  );
}

function page(id: string, title: string) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    compileScope: 'space',
    title,
    slug: id,
    pageType: 'source_summary',
    body: '',
    summary: null,
    compiledAt: new Date('2026-06-16T00:00:00.000Z'),
    compilerVersion: 'compiler@1',
    compilerRunId: 'run-1',
    compileTaskId: 'task-1',
    staleAt: null,
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
    updatedAt: new Date('2026-06-16T00:00:00.000Z'),
  };
}

function pageSource(knowledgePageId: string, sourcePageId: string) {
  return {
    workspaceId: 'workspace-1',
    knowledgePageId,
    sourcePageId,
    sourceVersion: 'v1',
    sourceRange: null,
    quoteHash: null,
    contentHash: `sha256:${sourcePageId}`,
    provenanceKind: 'synthesis_lineage',
    attachmentId: null,
  };
}

function link(
  id: string,
  fromKnowledgePageId: string,
  toKnowledgePageId: string,
  linkText: string,
) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    fromKnowledgePageId,
    toKnowledgePageId,
    targetPageId: null,
    targetSpaceId: null,
    linkText,
    linkType: 'wiki',
    isDangling: false,
    compilerRunId: 'run-1',
    compileTaskId: 'task-1',
    staleAt: null,
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
  };
}

function linkSource(linkId: string, sourcePageId: string) {
  return {
    workspaceId: 'workspace-1',
    linkId,
    sourcePageId,
    sourceVersion: 'v1',
    sourceRange: null,
    quoteHash: null,
    contentHash: `sha256:${sourcePageId}`,
    provenanceKind: 'synthesis_lineage',
    attachmentId: null,
  };
}

function graphEdge(
  id: string,
  fromKnowledgePageId: string,
  toKnowledgePageId: string,
  relation: string,
) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    fromKnowledgePageId,
    toKnowledgePageId,
    relation,
    compilerRunId: 'run-1',
    compileTaskId: 'task-1',
    staleAt: null,
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
  };
}

function graphEdgeSource(graphEdgeId: string, sourcePageId: string) {
  return {
    workspaceId: 'workspace-1',
    graphEdgeId,
    sourcePageId,
    sourceVersion: 'v1',
    sourceRange: null,
    quoteHash: null,
    contentHash: `sha256:${sourcePageId}`,
    provenanceKind: 'synthesis_lineage',
    attachmentId: null,
  };
}
