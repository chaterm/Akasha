import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
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
        parentSections: [],
        parentSectionSources: [],
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
          kind: 'page',
          degree: 2,
          artifactKind: 'source_summary',
          communityId: 'community-1',
        },
        {
          id: 'kp-2',
          title: 'Chaterm',
          spaceId: 'space-1',
          sourcePageId: 'source-2',
          kind: 'page',
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
        bridgeNodeIds: [],
        communityCount: 1,
      },
    });

    expect(capsuleRepo.findGraphCandidatesForSpace).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      limit: 3000,
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

  it('adds readable Wiki sections as child nodes and hides synthesis-only overview pages', async () => {
    const capsuleRepo = {
      findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
        pages: [
          page('kp-1', 'Architecture'),
          { ...page('overview-1', 'Space overview'), pageType: 'overview' },
        ],
        pageSources: [
          pageSource('kp-1', 'source-1'),
          pageSource('overview-1', 'source-1'),
        ],
        parentSections: [
          {
            id: 'section-1',
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            knowledgePageId: 'kp-1',
            stableKey: 'stable-1',
            headingPath: ['Architecture', 'Retrieval'],
            text: 'ACL filtering runs before candidate limits.',
            contentHash: 'hash-section-1',
            startOffset: 10,
            endOffset: 54,
            staleAt: null,
            createdAt: new Date('2026-06-16T00:00:00.000Z'),
            updatedAt: new Date('2026-06-16T00:00:00.000Z'),
          },
          {
            id: 'section-2',
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            knowledgePageId: 'kp-1',
            stableKey: 'stable-2',
            headingPath: [],
            text: '通过访问控制列表过滤候选页面。随后再执行结果数量限制。',
            contentHash: 'hash-section-2',
            startOffset: 55,
            endOffset: 84,
            staleAt: null,
            createdAt: new Date('2026-06-16T00:00:00.000Z'),
            updatedAt: new Date('2026-06-16T00:00:00.000Z'),
          },
        ],
        parentSectionSources: [
          {
            workspaceId: 'workspace-1',
            parentSectionId: 'section-1',
            sourcePageId: 'source-1',
            sourceVersion: 'v1',
            sourceRange: { startOffset: 10, endOffset: 54 },
            quoteHash: 'quote-1',
            contentHash: 'hash-section-1',
            provenanceKind: 'synthesis_lineage',
            attachmentId: null,
            createdAt: new Date('2026-06-16T00:00:00.000Z'),
          },
          {
            workspaceId: 'workspace-1',
            parentSectionId: 'section-2',
            sourcePageId: 'source-1',
            sourceVersion: 'v1',
            sourceRange: { startOffset: 55, endOffset: 84 },
            quoteHash: 'quote-2',
            contentHash: 'hash-section-2',
            provenanceKind: 'synthesis_lineage',
            attachmentId: null,
            createdAt: new Date('2026-06-16T00:00:00.000Z'),
          },
        ],
        links: [],
        linkSources: [],
        graphEdges: [],
        graphEdgeSources: [],
      }),
    };
    const service = createService({
      capsuleRepo,
      sourceAuthorization: {
        filterReadableSources: jest.fn().mockResolvedValue(['source-1']),
      },
    });

    const result = await service.getSpaceGraph({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      spaceId: 'space-1',
    });

    expect(result.nodes).toEqual([
      expect.objectContaining({
        id: 'kp-1',
        kind: 'page',
        degree: 2,
      }),
      expect.objectContaining({
        id: 'section:section-1',
        kind: 'section',
        parentPageId: 'kp-1',
        title: 'Retrieval',
        headingPath: ['Architecture', 'Retrieval'],
        excerpt: 'ACL filtering runs before candidate limits.',
      }),
      expect.objectContaining({
        id: 'section:section-2',
        kind: 'section',
        parentPageId: 'kp-1',
        title: '通过访问控制列表过滤候选页面',
        headingPath: [],
      }),
    ]);
    expect(result.edges).toEqual([
      {
        id: 'contains:section-1',
        from: 'kp-1',
        to: 'section:section-1',
        type: 'contains',
        label: '包含章节',
        weight: 1,
        reasons: ['section-membership'],
      },
      {
        id: 'contains:section-2',
        from: 'kp-1',
        to: 'section:section-2',
        type: 'contains',
        label: '包含章节',
        weight: 1,
        reasons: ['section-membership'],
      },
    ]);
  });

  it('derives bounded semantic relevance from shared sources', async () => {
    const capsuleRepo = {
      findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
        pages: [
          { ...page('kp-concept', 'Event sourcing'), pageType: 'concept' },
          { ...page('kp-entity', 'Event store'), pageType: 'entity' },
        ],
        pageSources: [
          pageSource('kp-concept', 'source-1'),
          pageSource('kp-entity', 'source-1'),
        ],
        parentSections: [],
        parentSectionSources: [],
        links: [],
        linkSources: [],
        graphEdges: [],
        graphEdgeSources: [],
      }),
    };
    const service = createService({
      capsuleRepo,
      sourceAuthorization: {
        filterReadableSources: jest.fn().mockResolvedValue(['source-1']),
      },
    });

    const result = await service.getSpaceGraph({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      spaceId: 'space-1',
    });

    expect(result.edges).toContainEqual({
      id: 'derived:kp-concept:kp-entity',
      from: 'kp-concept',
      to: 'kp-entity',
      type: 'semantic',
      label: '共享来源',
      weight: 5.2,
      reasons: ['semantic-edge'],
    });
    expect(result.nodes).toEqual([
      expect.objectContaining({ id: 'kp-concept', degree: 1 }),
      expect.objectContaining({ id: 'kp-entity', degree: 1 }),
    ]);
  });

  it('uses common neighbors but excludes catalog links and type-only affinity', async () => {
    const catalogLink = {
      ...link('catalog-link', 'kp-a', 'kp-b', 'catalog'),
      linkType: 'catalog_entry',
    };
    const capsuleRepo = {
      findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
        pages: [page('kp-a', 'A'), page('kp-b', 'B'), page('kp-c', 'C')],
        pageSources: [
          pageSource('kp-a', 'source-a'),
          pageSource('kp-b', 'source-b'),
          pageSource('kp-c', 'source-c'),
        ],
        parentSections: [],
        parentSectionSources: [],
        links: [
          link('link-a-c', 'kp-a', 'kp-c', 'A to C'),
          link('link-b-c', 'kp-b', 'kp-c', 'B to C'),
          catalogLink,
        ],
        linkSources: [
          linkSource('link-a-c', 'source-a'),
          linkSource('link-b-c', 'source-b'),
          linkSource('catalog-link', 'source-a'),
        ],
        graphEdges: [],
        graphEdgeSources: [],
      }),
    };
    const service = createService({
      capsuleRepo,
      sourceAuthorization: {
        filterReadableSources: jest
          .fn()
          .mockResolvedValue(['source-a', 'source-b', 'source-c']),
      },
    });

    const result = await service.getSpaceGraph({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      spaceId: 'space-1',
    });

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'link-a-c', type: 'link' }),
        expect.objectContaining({ id: 'link-b-c', type: 'link' }),
        expect.objectContaining({
          id: 'derived:kp-a:kp-b',
          type: 'semantic',
          label: '共同邻居',
        }),
      ]),
    );
    expect(result.edges).not.toContainEqual(
      expect.objectContaining({ id: 'catalog-link' }),
    );
    expect(
      result.edges.filter((edge) => edge.type === 'semantic'),
    ).toHaveLength(1);
  });

  it('does not create semantic edges from type affinity alone', async () => {
    const capsuleRepo = {
      findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
        pages: [page('kp-a', 'A'), page('kp-b', 'B')],
        pageSources: [
          pageSource('kp-a', 'source-a'),
          pageSource('kp-b', 'source-b'),
        ],
        parentSections: [],
        parentSectionSources: [],
        links: [],
        linkSources: [],
        graphEdges: [],
        graphEdgeSources: [],
      }),
    };
    const service = createService({
      capsuleRepo,
      sourceAuthorization: {
        filterReadableSources: jest
          .fn()
          .mockResolvedValue(['source-a', 'source-b']),
      },
    });

    const result = await service.getSpaceGraph({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      spaceId: 'space-1',
    });

    expect(result.edges).toEqual([]);
  });

  it('uses weighted Louvain communities and reports only cross-community bridges', async () => {
    const pageIds = ['a-1', 'a-2', 'a-3', 'b-1', 'b-2', 'b-3'];
    const links = [
      link('a-1-2', 'a-1', 'a-2', 'a'),
      link('a-2-3', 'a-2', 'a-3', 'a'),
      link('a-3-1', 'a-3', 'a-1', 'a'),
      link('b-1-2', 'b-1', 'b-2', 'b'),
      link('b-2-3', 'b-2', 'b-3', 'b'),
      link('b-3-1', 'b-3', 'b-1', 'b'),
      link('bridge', 'a-3', 'b-1', 'bridge'),
    ];
    const sourcePageIds = pageIds.map((id) => `source-${id}`);
    const service = createService({
      capsuleRepo: {
        findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
          pages: pageIds.map((id) => page(id, id)),
          pageSources: pageIds.map((id) => pageSource(id, `source-${id}`)),
          parentSections: [],
          parentSectionSources: [],
          links,
          linkSources: links.map((entry) =>
            linkSource(entry.id, `source-${entry.fromKnowledgePageId}`),
          ),
          graphEdges: [],
          graphEdgeSources: [],
        }),
      },
      sourceAuthorization: {
        filterReadableSources: jest.fn().mockResolvedValue(sourcePageIds),
      },
    });

    const result = await service.getSpaceGraph({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      spaceId: 'space-1',
    });

    expect(new Set(result.nodes.map((node) => node.communityId)).size).toBe(2);
    expect(result.insights).toEqual(
      expect.objectContaining({
        communityCount: 2,
        bridgeNodeIds: ['a-3', 'b-1'],
      }),
    );
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
      parentSections: [],
      parentSectionSources: [],
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
