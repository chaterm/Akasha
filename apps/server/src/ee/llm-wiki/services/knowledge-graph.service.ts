import { Injectable } from '@nestjs/common';
import { UndirectedGraph } from 'graphology';
import * as louvainModule from 'graphology-communities-louvain';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { SpaceAuthorizationService } from '../../../core/space/services/space-authorization.service';
import {
  DEFAULT_GRAPH_NODE_LIMIT,
  MAX_GRAPH_NODE_LIMIT,
} from '../knowledge-graph.constants';
import { KnowledgeSourceAuthorizationService } from './knowledge-source-authorization.service';

const runLouvain = (louvainModule.default ??
  louvainModule) as typeof louvainModule.default;

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
      .filter((link) => link.linkType !== 'catalog_entry')
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
      .filter((edge) => edge.relation !== 'catalog_entry')
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

    const derivedSemanticEdges = buildDerivedSemanticEdges({
      pages: visiblePages,
      pageSourcesByPageId,
      directEdges: linkEdges,
      explicitSemanticEdges: semanticEdges,
    });

    const sectionEdges = visibleSections.map((section) => ({
      id: `contains:${section.id}`,
      from: section.knowledgePageId,
      to: sectionNodeId(section.id),
      type: 'contains' as const,
      label: '包含章节',
      weight: 1,
      reasons: ['section-membership' as const],
    }));

    const relationshipEdges = [
      ...linkEdges,
      ...semanticEdges,
      ...derivedSemanticEdges,
    ];
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
    const visiblePageById = new Map(
      visiblePages.map((page) => [page.id, page] as const),
    );
    const sectionNodes = visibleSections.map((section) => {
      const headingPath = readHeadingPath(section.headingPath);
      return {
        id: sectionNodeId(section.id),
        title: buildSectionTitle({
          headingPath,
          text: section.text,
          pageTitle: visiblePageById.get(section.knowledgePageId)?.title,
        }),
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
        [...linkEdges, ...semanticEdges],
      ),
    };
  }
}

const MAX_DERIVED_SEMANTIC_NEIGHBORS = 6;
const MAX_DERIVED_SEMANTIC_CANDIDATES = 250_000;

const TYPE_AFFINITY: Record<string, Record<string, number>> = {
  entity: {
    concept: 1.2,
    entity: 0.8,
    source_summary: 1,
    comparison: 1,
  },
  concept: {
    entity: 1.2,
    concept: 0.8,
    source_summary: 1,
    comparison: 1.2,
  },
  source_summary: {
    entity: 1,
    concept: 1,
    source_summary: 0.5,
    comparison: 1,
  },
  comparison: {
    entity: 1,
    concept: 1.2,
    source_summary: 1,
    comparison: 0.8,
  },
};

function buildDerivedSemanticEdges<
  TPage extends { id: string; pageType: string | null },
>(input: {
  pages: TPage[];
  pageSourcesByPageId: Map<string, Array<{ sourcePageId: string }>>;
  directEdges: Array<{ from: string; to: string }>;
  explicitSemanticEdges: Array<{ from: string; to: string }>;
}): KnowledgeGraphEdge[] {
  const pageById = new Map(input.pages.map((page) => [page.id, page]));
  const sourceIdsByPageId = new Map(
    input.pages.map((page) => [
      page.id,
      new Set(
        (input.pageSourcesByPageId.get(page.id) ?? []).map(
          (source) => source.sourcePageId,
        ),
      ),
    ]),
  );
  const pageIdsBySourceId = new Map<string, string[]>();
  for (const [pageId, sourceIds] of sourceIdsByPageId) {
    for (const sourceId of sourceIds) {
      pageIdsBySourceId.set(sourceId, [
        ...(pageIdsBySourceId.get(sourceId) ?? []),
        pageId,
      ]);
    }
  }

  const neighborsByPageId = new Map(
    input.pages.map((page) => [page.id, new Set<string>()]),
  );
  for (const edge of input.directEdges) {
    neighborsByPageId.get(edge.from)?.add(edge.to);
    neighborsByPageId.get(edge.to)?.add(edge.from);
  }

  const candidatePairs = new Map<string, [string, string]>();
  const addCandidate = (first: string, second: string) => {
    if (
      first === second ||
      candidatePairs.size >= MAX_DERIVED_SEMANTIC_CANDIDATES
    ) {
      return;
    }
    const pair = orderedPair(first, second);
    candidatePairs.set(pairKey(pair[0], pair[1]), pair);
  };
  for (const pageIds of pageIdsBySourceId.values()) {
    const uniquePageIds = [...new Set(pageIds)].sort();
    for (let left = 0; left < uniquePageIds.length; left++) {
      for (let right = left + 1; right < uniquePageIds.length; right++) {
        addCandidate(uniquePageIds[left], uniquePageIds[right]);
      }
    }
  }
  for (const neighbors of neighborsByPageId.values()) {
    const neighborIds = [...neighbors].sort();
    for (let left = 0; left < neighborIds.length; left++) {
      for (let right = left + 1; right < neighborIds.length; right++) {
        addCandidate(neighborIds[left], neighborIds[right]);
      }
    }
  }

  const explicitPairs = new Set(
    input.explicitSemanticEdges.map((edge) => {
      const pair = orderedPair(edge.from, edge.to);
      return pairKey(pair[0], pair[1]);
    }),
  );
  const candidates: Array<{
    from: string;
    to: string;
    label: string;
    score: number;
  }> = [];
  for (const [key, [from, to]] of candidatePairs) {
    if (explicitPairs.has(key)) continue;
    const fromPage = pageById.get(from);
    const toPage = pageById.get(to);
    if (!fromPage || !toPage) continue;

    const sharedSourceCount = intersectionSize(
      sourceIdsByPageId.get(from) ?? new Set(),
      sourceIdsByPageId.get(to) ?? new Set(),
    );
    const commonNeighborScore = adamicAdarScore(
      neighborsByPageId.get(from) ?? new Set(),
      neighborsByPageId.get(to) ?? new Set(),
      neighborsByPageId,
    );
    if (sharedSourceCount === 0 && commonNeighborScore === 0) continue;

    const score =
      sharedSourceCount * 4 +
      commonNeighborScore * 1.5 +
      typeAffinity(fromPage.pageType, toPage.pageType);
    candidates.push({
      from,
      to,
      label:
        sharedSourceCount > 0 && commonNeighborScore > 0
          ? '共享来源 · 共同邻居'
          : sharedSourceCount > 0
            ? '共享来源'
            : '共同邻居',
      score: Math.round(score * 1_000) / 1_000,
    });
  }

  const derivedDegree = new Map<string, number>();
  const edges: KnowledgeGraphEdge[] = [];
  for (const candidate of candidates.sort(
    (left, right) =>
      right.score - left.score ||
      pairKey(left.from, left.to).localeCompare(pairKey(right.from, right.to)),
  )) {
    if (
      (derivedDegree.get(candidate.from) ?? 0) >=
        MAX_DERIVED_SEMANTIC_NEIGHBORS ||
      (derivedDegree.get(candidate.to) ?? 0) >= MAX_DERIVED_SEMANTIC_NEIGHBORS
    ) {
      continue;
    }
    edges.push({
      id: `derived:${candidate.from}:${candidate.to}`,
      from: candidate.from,
      to: candidate.to,
      type: 'semantic',
      label: candidate.label,
      weight: candidate.score,
      reasons: ['semantic-edge'],
    });
    derivedDegree.set(
      candidate.from,
      (derivedDegree.get(candidate.from) ?? 0) + 1,
    );
    derivedDegree.set(candidate.to, (derivedDegree.get(candidate.to) ?? 0) + 1);
  }
  return edges;
}

function orderedPair(first: string, second: string): [string, string] {
  return first.localeCompare(second) <= 0 ? [first, second] : [second, first];
}

function pairKey(first: string, second: string): string {
  return `${first}\u001f${second}`;
}

function intersectionSize(first: Set<string>, second: Set<string>): number {
  let count = 0;
  for (const value of first) {
    if (second.has(value)) count++;
  }
  return count;
}

function adamicAdarScore(
  first: Set<string>,
  second: Set<string>,
  neighborsByPageId: Map<string, Set<string>>,
): number {
  let score = 0;
  for (const neighborId of first) {
    if (!second.has(neighborId)) continue;
    const degree = neighborsByPageId.get(neighborId)?.size ?? 0;
    score += 1 / Math.log(Math.max(degree, 2));
  }
  return score;
}

function typeAffinity(
  firstType: string | null,
  secondType: string | null,
): number {
  if (!firstType || !secondType) return 0.5;
  const forward = TYPE_AFFINITY[firstType]?.[secondType] ?? 0.5;
  const backward = TYPE_AFFINITY[secondType]?.[firstType] ?? 0.5;
  return (forward + backward) / 2;
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

function buildSectionTitle(input: {
  headingPath: string[];
  text: string;
  pageTitle?: string;
}): string {
  const heading = input.headingPath[input.headingPath.length - 1]?.trim();
  if (heading) return heading;

  const compact = input.text
    .replace(/^\s*#{1,6}\s+/u, '')
    .replace(/[`*_>\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentenceEnd = compact.search(/[。！？.!?]/u);
  const firstSentence = (
    sentenceEnd >= 0 ? compact.slice(0, sentenceEnd) : compact
  ).trim();
  if (firstSentence) {
    return firstSentence.length > 32
      ? `${firstSentence.slice(0, 31)}…`
      : firstSentence;
  }
  return input.pageTitle ? `${input.pageTitle} · 内容` : '内容片段';
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
  edges: Array<{ from: string; to: string; weight?: number }>,
): Map<string, string> {
  if (pages.length === 0) return new Map();

  const graph = new UndirectedGraph({ allowSelfLoops: false });
  const pageIds = [...new Set(pages.map((page) => page.id))].sort();
  for (const pageId of pageIds) graph.addNode(pageId);

  for (const edge of edges) {
    if (
      edge.from === edge.to ||
      !graph.hasNode(edge.from) ||
      !graph.hasNode(edge.to)
    ) {
      continue;
    }
    const [from, to] = orderedPair(edge.from, edge.to);
    const key = pairKey(from, to);
    const weight = Math.max(Number(edge.weight ?? 1), 0.001);
    if (graph.hasEdge(key)) {
      graph.updateEdgeAttribute(
        key,
        'weight',
        (current) => Number(current ?? 0) + weight,
      );
    } else {
      graph.addUndirectedEdgeWithKey(key, from, to, { weight });
    }
  }

  const rawAssignments = runLouvain(graph, {
    resolution: 1,
    randomWalk: false,
    getEdgeWeight: 'weight',
  });
  const membersByRawCommunity = new Map<number, string[]>();
  for (const pageId of pageIds) {
    const rawCommunity = rawAssignments[pageId];
    const members = membersByRawCommunity.get(rawCommunity) ?? [];
    members.push(pageId);
    membersByRawCommunity.set(rawCommunity, members);
  }
  const orderedCommunities = [...membersByRawCommunity.values()].sort(
    (left, right) =>
      right.length - left.length || left[0].localeCompare(right[0]),
  );
  const communityByPageId = new Map<string, string>();
  orderedCommunities.forEach((members, index) => {
    const communityId = `community-${index + 1}`;
    for (const pageId of members) {
      communityByPageId.set(pageId, communityId);
    }
  });

  return communityByPageId;
}

function buildInsights<T extends { id: string }>(
  pages: T[],
  degreeByPageId: Map<string, number>,
  communityByPageId: Map<string, string>,
  edges: Array<{ from: string; to: string }>,
): KnowledgeGraphInsights {
  const bridgeNodeIds = new Set<string>();
  for (const edge of edges) {
    const fromCommunity = communityByPageId.get(edge.from);
    const toCommunity = communityByPageId.get(edge.to);
    if (fromCommunity && toCommunity && fromCommunity !== toCommunity) {
      bridgeNodeIds.add(edge.from);
      bridgeNodeIds.add(edge.to);
    }
  }
  return {
    isolatedNodeIds: pages
      .filter((page) => (degreeByPageId.get(page.id) ?? 0) === 0)
      .map((page) => page.id),
    bridgeNodeIds: pages
      .filter((page) => bridgeNodeIds.has(page.id))
      .map((page) => page.id),
    communityCount: new Set(communityByPageId.values()).size,
  };
}
