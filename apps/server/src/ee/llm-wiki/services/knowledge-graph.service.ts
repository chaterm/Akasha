import { Injectable } from '@nestjs/common';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { SpaceAuthorizationService } from '../../../core/space/services/space-authorization.service';
import {
  DEFAULT_GRAPH_NODE_LIMIT,
  MAX_GRAPH_NODE_LIMIT,
} from '../knowledge-graph.constants';
import { KnowledgeSourceAuthorizationService } from './knowledge-source-authorization.service';

export type KnowledgeGraphResult = {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  insights: KnowledgeGraphInsights;
};

export type KnowledgeGraphNode = {
  id: string;
  title: string;
  spaceId: string;
  sourcePageId?: string;
  kind: 'page' | 'section';
  parentPageId?: string;
  headingPath?: string[];
  excerpt?: string;
  degree: number;
  artifactKind?: string;
  communityId: string;
};

export type KnowledgeGraphEdge = {
  id: string;
  from: string;
  to: string;
  type: 'link' | 'semantic' | 'contains';
  label: string;
  weight: number;
  reasons: KnowledgeGraphEdgeReason[];
};

export type KnowledgeGraphEdgeReason =
  | 'direct-link'
  | 'semantic-edge'
  | 'section-membership';

export type KnowledgeGraphInsights = {
  isolatedNodeIds: string[];
  bridgeNodeIds: string[];
  communityCount: number;
};

@Injectable()
export class KnowledgeGraphService {
  constructor(
    private readonly userRepo: UserRepo,
    private readonly spaceAuthorization: SpaceAuthorizationService,
    private readonly capsuleRepo: KnowledgeCapsuleRepo,
    private readonly sourceAuthorization: KnowledgeSourceAuthorizationService,
  ) {}

  async getSpaceGraph(input: {
    workspaceId: string;
    userId: string;
    spaceId: string;
    limit?: number;
  }): Promise<KnowledgeGraphResult> {
    const user = await this.userRepo.findById(input.userId, input.workspaceId);
    if (!user) {
      return emptyGraph();
    }

    const readableSpaceIds =
      await this.spaceAuthorization.filterReadableSpaceIds({
        user,
        spaceIds: [input.spaceId],
      });
    if (!readableSpaceIds.includes(input.spaceId)) {
      return emptyGraph();
    }

    const graph = await this.capsuleRepo.findGraphCandidatesForSpace({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      limit: clampLimit(input.limit),
    });

    const allSourcePageIds = unique([
      ...graph.pageSources.map((source) => source.sourcePageId),
      ...graph.parentSectionSources.map((source) => source.sourcePageId),
      ...graph.linkSources.map((source) => source.sourcePageId),
      ...graph.graphEdgeSources.map((source) => source.sourcePageId),
    ]);
    const readableSourcePageIds =
      await this.sourceAuthorization.filterReadableSources({
        workspaceId: input.workspaceId,
        userId: input.userId,
        sourcePageIds: allSourcePageIds,
      });
    const readableSourceSet = new Set(readableSourcePageIds);

    const pageSourcesByPageId = groupBy(
      graph.pageSources,
      (source) => source.knowledgePageId,
    );
    const visiblePages = graph.pages.filter(
      (page) =>
        page.pageType !== 'overview' &&
        allSourcesReadable(
          pageSourcesByPageId.get(page.id) ?? [],
          readableSourceSet,
        ),
    );
    const visiblePageIds = new Set(visiblePages.map((page) => page.id));

    const parentSectionSourcesBySectionId = groupBy(
      graph.parentSectionSources,
      (source) => source.parentSectionId,
    );
    const visibleSections = graph.parentSections.filter(
      (section) =>
        visiblePageIds.has(section.knowledgePageId) &&
        allSourcesReadable(
          parentSectionSourcesBySectionId.get(section.id) ?? [],
          readableSourceSet,
        ),
    );

    const linkSourcesByLinkId = groupBy(
      graph.linkSources,
      (source) => source.linkId,
    );
    const linkEdges = graph.links
      .filter((link) => link.toKnowledgePageId)
      .filter(
        (link) =>
          visiblePageIds.has(link.fromKnowledgePageId) &&
          visiblePageIds.has(link.toKnowledgePageId as string) &&
          allSourcesReadable(
            linkSourcesByLinkId.get(link.id) ?? [],
            readableSourceSet,
          ),
      )
      .map((link) => ({
        id: link.id,
        from: link.fromKnowledgePageId,
        to: link.toKnowledgePageId as string,
        type: 'link' as const,
        label: link.linkText || link.linkType,
        weight: 3,
        reasons: ['direct-link' as const],
      }));

    const graphEdgeSourcesByEdgeId = groupBy(
      graph.graphEdgeSources,
      (source) => source.graphEdgeId,
    );
    const semanticEdges = graph.graphEdges
      .filter(
        (edge) =>
          visiblePageIds.has(edge.fromKnowledgePageId) &&
          visiblePageIds.has(edge.toKnowledgePageId) &&
          allSourcesReadable(
            graphEdgeSourcesByEdgeId.get(edge.id) ?? [],
            readableSourceSet,
          ),
      )
      .map((edge) => ({
        id: edge.id,
        from: edge.fromKnowledgePageId,
        to: edge.toKnowledgePageId,
        type: 'semantic' as const,
        label: edge.relation,
        weight: 2,
        reasons: ['semantic-edge' as const],
      }));

    const sectionEdges = visibleSections.map((section) => ({
      id: `contains:${section.id}`,
      from: section.knowledgePageId,
      to: sectionNodeId(section.id),
      type: 'contains' as const,
      label: '包含章节',
      weight: 1,
      reasons: ['section-membership' as const],
    }));

    const relationshipEdges = [...linkEdges, ...semanticEdges];
    const edges = [...relationshipEdges, ...sectionEdges];
    const degreeByNodeId = new Map<string, number>();
    for (const edge of edges) {
      degreeByNodeId.set(edge.from, (degreeByNodeId.get(edge.from) ?? 0) + 1);
      degreeByNodeId.set(edge.to, (degreeByNodeId.get(edge.to) ?? 0) + 1);
    }
    const relationshipDegreeByPageId = new Map<string, number>();
    for (const edge of relationshipEdges) {
      relationshipDegreeByPageId.set(
        edge.from,
        (relationshipDegreeByPageId.get(edge.from) ?? 0) + 1,
      );
      relationshipDegreeByPageId.set(
        edge.to,
        (relationshipDegreeByPageId.get(edge.to) ?? 0) + 1,
      );
    }
    const communityByPageId = assignCommunities(
      visiblePages,
      relationshipEdges,
    );
    const pageNodes = visiblePages.map((page) => ({
      id: page.id,
      title: page.title,
      spaceId: page.spaceId,
      sourcePageId: singleSourcePageId(pageSourcesByPageId.get(page.id) ?? []),
      kind: 'page' as const,
      degree: degreeByNodeId.get(page.id) ?? 0,
      artifactKind: page.pageType ?? undefined,
      communityId: communityByPageId.get(page.id) ?? 'community-0',
    }));
    const sectionNodes = visibleSections.map((section) => {
      const headingPath = readHeadingPath(section.headingPath);
      return {
        id: sectionNodeId(section.id),
        title: headingPath[headingPath.length - 1] || '正文',
        spaceId: section.spaceId,
        sourcePageId: singleSourcePageId(
          parentSectionSourcesBySectionId.get(section.id) ?? [],
        ),
        kind: 'section' as const,
        parentPageId: section.knowledgePageId,
        headingPath,
        excerpt: buildExcerpt(section.text),
        degree: degreeByNodeId.get(sectionNodeId(section.id)) ?? 0,
        artifactKind: 'source_section',
        communityId:
          communityByPageId.get(section.knowledgePageId) ?? 'community-0',
      };
    });

    return {
      nodes: [...pageNodes, ...sectionNodes],
      edges,
      insights: buildInsights(
        visiblePages,
        relationshipDegreeByPageId,
        communityByPageId,
      ),
    };
  }
}

function sectionNodeId(sectionId: string): string {
  return `section:${sectionId}`;
}

function readHeadingPath(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((part): part is string => typeof part === 'string')
    : [];
}

function buildExcerpt(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}…` : compact;
}

function emptyGraph(): KnowledgeGraphResult {
  return {
    nodes: [],
    edges: [],
    insights: { isolatedNodeIds: [], bridgeNodeIds: [], communityCount: 0 },
  };
}

function clampLimit(limit?: number): number {
  if (!limit || limit <= 0) {
    return DEFAULT_GRAPH_NODE_LIMIT;
  }

  return Math.min(limit, MAX_GRAPH_NODE_LIMIT);
}

function allSourcesReadable<T extends { sourcePageId: string }>(
  sources: T[],
  readableSourceSet: Set<string>,
): boolean {
  return (
    sources.length > 0 &&
    sources.every((source) => readableSourceSet.has(source.sourcePageId))
  );
}

function singleSourcePageId<T extends { sourcePageId: string }>(
  sources: T[],
): string | undefined {
  const sourcePageIds = unique(sources.map((source) => source.sourcePageId));
  return sourcePageIds.length === 1 ? sourcePageIds[0] : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function groupBy<T>(
  values: T[],
  keyOf: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = grouped.get(key) ?? [];
    group.push(value);
    grouped.set(key, group);
  }
  return grouped;
}

function assignCommunities<T extends { id: string }>(
  pages: T[],
  edges: Array<{ from: string; to: string }>,
): Map<string, string> {
  const neighborsByPageId = new Map<string, Set<string>>();
  for (const page of pages) {
    neighborsByPageId.set(page.id, new Set());
  }
  for (const edge of edges) {
    neighborsByPageId.get(edge.from)?.add(edge.to);
    neighborsByPageId.get(edge.to)?.add(edge.from);
  }

  const communityByPageId = new Map<string, string>();
  let communityIndex = 0;

  for (const page of pages) {
    if (communityByPageId.has(page.id)) continue;

    communityIndex += 1;
    const communityId = `community-${communityIndex}`;
    const stack = [page.id];

    while (stack.length > 0) {
      const pageId = stack.pop() as string;
      if (communityByPageId.has(pageId)) continue;

      communityByPageId.set(pageId, communityId);
      for (const neighborId of neighborsByPageId.get(pageId) ?? []) {
        if (!communityByPageId.has(neighborId)) {
          stack.push(neighborId);
        }
      }
    }
  }

  return communityByPageId;
}

function buildInsights<T extends { id: string }>(
  pages: T[],
  degreeByPageId: Map<string, number>,
  communityByPageId: Map<string, string>,
): KnowledgeGraphInsights {
  return {
    isolatedNodeIds: pages
      .filter((page) => (degreeByPageId.get(page.id) ?? 0) === 0)
      .map((page) => page.id),
    bridgeNodeIds: pages
      .filter((page) => (degreeByPageId.get(page.id) ?? 0) > 1)
      .map((page) => page.id),
    communityCount: new Set(communityByPageId.values()).size,
  };
}
