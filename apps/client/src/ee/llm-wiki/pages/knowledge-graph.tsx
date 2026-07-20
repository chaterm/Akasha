import {
  PointerEvent,
  WheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Container,
  Divider,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Helmet } from "react-helmet-async";
import {
  IconAlertTriangle,
  IconArrowsMaximize,
  IconArrowLeft,
  IconFileText,
  IconFocus2,
  IconGitFork,
  IconRefresh,
  IconSearch,
  IconZoomIn,
  IconZoomOut,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { getAppName } from "@/lib/config";
import {
  useGetSpaceBySlugQuery,
  useGetSpacesQuery,
} from "@/features/space/queries/space-query";
import { getKnowledgeGraph } from "../services/knowledge-service";
import type {
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeGraphResult,
} from "../types/knowledge.types";
import classes from "../styles/knowledge-graph.module.css";

const GRAPH_NODE_LIMIT = 3_000;
const OVERVIEW_NODE_LIMIT = 80;
const GRAPH_WIDTH = 1100;
const GRAPH_HEIGHT = 680;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 3.2;
const ZOOM_STEP = 1.2;
const ENABLE_GRAPH_ANIMATION = import.meta.env.MODE !== "test";
const EMPTY_GRAPH: KnowledgeGraphResult = {
  nodes: [],
  edges: [],
  insights: {
    isolatedNodeIds: [],
    bridgeNodeIds: [],
    communityCount: 0,
  },
};

type GraphTransform = {
  x: number;
  y: number;
  scale: number;
};

type DragState = {
  clientX: number;
  clientY: number;
  transform: GraphTransform;
};

type NodeDragState = {
  nodeId: string;
};

type GraphPoint = {
  x: number;
  y: number;
};

type SimulatedNode = GraphPoint & {
  vx: number;
  vy: number;
  degree: number;
  kind: KnowledgeGraphNode["kind"];
};

export default function KnowledgeGraphPage() {
  const { t } = useTranslation();
  const { spaceSlug } = useParams();
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [edgeTypes, setEdgeTypes] = useState<KnowledgeGraphEdge["type"][]>([
    "link",
    "semantic",
  ]);
  const [showIsolated, setShowIsolated] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusPageId, setFocusPageId] = useState<string | null>(null);
  const { data: routeSpace, isLoading: routeSpaceLoading } =
    useGetSpaceBySlugQuery(spaceSlug ?? "");
  const { data: spacesData, isLoading: spacesLoading } = useGetSpacesQuery({
    limit: 100,
  });
  const spaces = spacesData?.items ?? [];
  const isSpaceRoute = Boolean(spaceSlug);
  const spaceOptions = useMemo(
    () =>
      routeSpace
        ? [{ value: routeSpace.id, label: routeSpace.name }]
        : spaces.map((space) => ({ value: space.id, label: space.name })),
    [routeSpace, spaces],
  );

  useEffect(() => {
    if (routeSpace?.id && spaceId !== routeSpace.id) {
      setSpaceId(routeSpace.id);
      return;
    }
    if (!spaceId && spaceOptions.length > 0) {
      setSpaceId(spaceOptions[0].value);
    }
  }, [routeSpace?.id, spaceId, spaceOptions]);

  const graphQuery = useQuery({
    queryKey: ["knowledge-graph", spaceId],
    queryFn: () =>
      getKnowledgeGraph({
        spaceId: spaceId as string,
        limit: GRAPH_NODE_LIMIT,
      }),
    enabled: Boolean(spaceId),
  });

  const graph = graphQuery.data ?? EMPTY_GRAPH;
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);
  const visibleGraph = useMemo(
    () => filterGraph(graph, search, edgeTypes, focusPageId, showIsolated),
    [edgeTypes, focusPageId, graph, search, showIsolated],
  );
  const persistentLabelNodeIds = useMemo(() => {
    if (focusPageId || visibleGraph.nodes.length <= 24) {
      return new Set(visibleGraph.nodes.map((node) => node.id));
    }
    return new Set(
      [...visibleGraph.nodes]
        .sort((a, b) => b.degree - a.degree)
        .slice(0, 16)
        .map((node) => node.id),
    );
  }, [focusPageId, visibleGraph.nodes]);
  const initialLayout = useMemo(
    () => buildInitialGraphLayout(visibleGraph.nodes, visibleGraph.edges),
    [visibleGraph.nodes, visibleGraph.edges],
  );
  const svgRef = useRef<SVGSVGElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const simulationTickRef = useRef(0);
  const [positions, setPositions] = useState<Map<string, SimulatedNode>>(() =>
    initializeSimulation(visibleGraph.nodes, initialLayout),
  );
  const [transform, setTransform] = useState<GraphTransform>(() =>
    fitGraphTransform(visibleGraph.nodes, initialLayout),
  );
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [nodeDragState, setNodeDragState] = useState<NodeDragState | null>(
    null,
  );
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [activeEdgeId, setActiveEdgeId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedNodeId(null);
    setFocusPageId(null);
  }, [spaceId]);

  const focusNode = useCallback((node: KnowledgeGraphNode) => {
    setFocusPageId(
      node.kind === "section" ? (node.parentPageId ?? null) : node.id,
    );
    setSelectedNodeId(node.id);
  }, []);

  const fitGraph = useCallback(() => {
    setTransform(fitGraphTransform(visibleGraph.nodes, positions));
  }, [positions, visibleGraph.nodes]);

  useEffect(() => {
    const nextPositions = initializeSimulation(
      visibleGraph.nodes,
      initialLayout,
    );
    setPositions(nextPositions);
    setTransform(fitGraphTransform(visibleGraph.nodes, initialLayout));
    simulationTickRef.current = 0;
  }, [initialLayout, visibleGraph.nodes]);

  useEffect(() => {
    if (!ENABLE_GRAPH_ANIMATION) return;

    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
    }

    const animate = () => {
      if (nodeDragState) {
        animationRef.current = requestAnimationFrame(animate);
        return;
      }

      simulationTickRef.current += 1;
      setPositions((current) =>
        simulateGraphStep({
          current,
          edges: visibleGraph.edges,
          width: GRAPH_WIDTH,
          height: GRAPH_HEIGHT,
        }),
      );

      if (simulationTickRef.current < 220) {
        animationRef.current = requestAnimationFrame(animate);
      } else {
        animationRef.current = null;
      }
    };

    if (positions.size > 1) {
      animationRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [nodeDragState, positions.size, visibleGraph.edges]);

  const zoomAt = useCallback((factor: number, center = graphCenter()) => {
    setTransform((current) => {
      const nextScale = clamp(current.scale * factor, MIN_ZOOM, MAX_ZOOM);
      const scaleRatio = nextScale / current.scale;

      return {
        scale: nextScale,
        x: center.x - (center.x - current.x) * scaleRatio,
        y: center.y - (center.y - current.y) * scaleRatio,
      };
    });
  }, []);

  const handleWheel = useCallback(
    (event: WheelEvent<SVGSVGElement>) => {
      event.preventDefault();
      const point = clientPointToGraphPoint(svgRef.current, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
      zoomAt(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, point);
    },
    [zoomAt],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      if ((event.target as Element).closest("a")) return;

      event.currentTarget.setPointerCapture(event.pointerId);
      setDragState({
        clientX: event.clientX,
        clientY: event.clientY,
        transform,
      });
    },
    [transform],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      if (nodeDragState) {
        const point = clientPointToWorldPoint(svgRef.current, transform, {
          clientX: event.clientX,
          clientY: event.clientY,
        });

        setPositions((current) => {
          const next = clonePositions(current);
          const node = next.get(nodeDragState.nodeId);
          if (node) {
            next.set(nodeDragState.nodeId, {
              ...node,
              x: point.x,
              y: point.y,
              vx: 0,
              vy: 0,
            });
          }
          return next;
        });
        return;
      }

      if (!dragState) return;

      const rect = svgRef.current?.getBoundingClientRect();
      const unitX = rect?.width ? GRAPH_WIDTH / rect.width : 1;
      const unitY = rect?.height ? GRAPH_HEIGHT / rect.height : 1;

      setTransform({
        ...dragState.transform,
        x: dragState.transform.x + (event.clientX - dragState.clientX) * unitX,
        y: dragState.transform.y + (event.clientY - dragState.clientY) * unitY,
      });
    },
    [dragState, nodeDragState, transform],
  );

  const handlePointerEnd = useCallback(() => {
    setDragState(null);
    setNodeDragState(null);
    simulationTickRef.current = 0;
  }, []);

  const handleNodePointerDown = useCallback(
    (event: PointerEvent<SVGGElement>, nodeId: string) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      setNodeDragState({ nodeId });
    },
    [],
  );

  return (
    <>
      <Helmet>
        <title>
          {t("Relationship graph")} - {getAppName()}
        </title>
      </Helmet>

      <Container fluid className={classes.pageContainer}>
        <Stack gap="lg" className={classes.pageStack}>
          <Group justify="space-between" align="center">
            <Group gap="sm">
              <IconGitFork size={24} stroke={1.8} />
              <Title order={1} size="h3">
                {t("Relationship graph")}
              </Title>
              <Badge variant="light">{visibleGraph.nodes.length}</Badge>
            </Group>
            <Group gap="sm">
              <Button
                component={Link}
                to={spaceSlug ? `/s/${spaceSlug}` : "/knowledge"}
                variant="default"
                leftSection={<IconArrowLeft size={16} />}
              >
                {spaceSlug ? t("Space") : t("Knowledge")}
              </Button>
              <Button
                variant="default"
                leftSection={<IconRefresh size={16} />}
                loading={graphQuery.isFetching}
                disabled={!spaceId}
                onClick={() => graphQuery.refetch()}
              >
                {t("Refresh")}
              </Button>
            </Group>
          </Group>

          <Group align="end" gap="sm">
            <Select
              data={spaceOptions}
              value={spaceId}
              onChange={setSpaceId}
              label={t("Space")}
              searchable
              disabled={isSpaceRoute || spacesLoading || routeSpaceLoading}
              className={classes.spaceSelect}
            />
            <TextInput
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              label={t("Search")}
              leftSection={<IconSearch size={16} />}
              className={classes.searchInput}
            />
            <Checkbox
              checked={edgeTypes.includes("link")}
              onChange={(event) =>
                setEdgeTypes((current) =>
                  event.currentTarget.checked
                    ? uniqueEdgeTypes([...current, "link"])
                    : current.filter((type) => type !== "link"),
                )
              }
              label={t("Links")}
            />
            <Checkbox
              checked={edgeTypes.includes("semantic")}
              onChange={(event) =>
                setEdgeTypes((current) =>
                  event.currentTarget.checked
                    ? uniqueEdgeTypes([...current, "semantic"])
                    : current.filter((type) => type !== "semantic"),
                )
              }
              label={t("Semantic")}
            />
            <Checkbox
              checked={showIsolated}
              onChange={(event) => setShowIsolated(event.currentTarget.checked)}
              label={t("Isolated pages")}
            />
            {(spacesLoading || routeSpaceLoading || graphQuery.isLoading) && (
              <Loader size="sm" />
            )}
          </Group>

          <Group gap="xs">
            <Badge variant="light">
              {t("Pages")}:{" "}
              {
                visibleGraph.nodes.filter((node) => node.kind !== "section")
                  .length
              }
            </Badge>
            <Badge variant="light" color="violet">
              {t("Sections")}:{" "}
              {
                visibleGraph.nodes.filter((node) => node.kind === "section")
                  .length
              }
            </Badge>
            <Badge variant="light">
              {t("Links")}:{" "}
              {visibleGraph.edges.filter((edge) => edge.type === "link").length}
            </Badge>
            <Badge variant="light" color="green">
              {t("Semantic")}:{" "}
              {
                visibleGraph.edges.filter((edge) => edge.type === "semantic")
                  .length
              }
            </Badge>
            <Badge variant="dot" color={focusPageId ? "blue" : "gray"}>
              {focusPageId ? t("Focused neighborhood") : t("Overview")}
            </Badge>
            {focusPageId && (
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() => setFocusPageId(null)}
              >
                {t("Back to overview")}
              </Button>
            )}
          </Group>

          {graphQuery.isError && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />}>
              {graphQuery.error.message}
            </Alert>
          )}

          <section className={classes.graphPanel}>
            {visibleGraph.nodes.length === 0 && !graphQuery.isLoading ? (
              <div className={classes.emptyState}>
                <IconGitFork size={36} stroke={1.4} />
                <Text fw={600}>{t("No relationship graph yet")}</Text>
              </div>
            ) : (
              <>
                <Group gap={6} className={classes.graphControls}>
                  <Tooltip label={t("Zoom out")}>
                    <ActionIcon
                      variant="default"
                      aria-label={t("Zoom out")}
                      onClick={() => zoomAt(1 / ZOOM_STEP)}
                    >
                      <IconZoomOut size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label={t("Zoom in")}>
                    <ActionIcon
                      variant="default"
                      aria-label={t("Zoom in")}
                      onClick={() => zoomAt(ZOOM_STEP)}
                    >
                      <IconZoomIn size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label={t("Fit graph")}>
                    <ActionIcon
                      variant="default"
                      aria-label={t("Fit graph")}
                      onClick={fitGraph}
                    >
                      <IconArrowsMaximize size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
                <div className={classes.graphLegend}>
                  <span>
                    <i className={classes.pageSwatch} />
                    {t("Wiki page")}
                  </span>
                  <span>
                    <i className={classes.sectionSwatch} />
                    {t("Section")}
                  </span>
                  <span>
                    <i className={classes.linkSwatch} />
                    {t("Direct link")}
                  </span>
                  <span>
                    <i className={classes.semanticSwatch} />
                    {t("Semantic relation")}
                  </span>
                </div>
                <svg
                  ref={svgRef}
                  className={classes.graphSvg}
                  viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
                  role="img"
                  aria-label={t("Relationship graph")}
                  onWheel={handleWheel}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerEnd}
                  onPointerCancel={handlePointerEnd}
                >
                  <defs>
                    <marker
                      id="knowledge-graph-arrow"
                      markerWidth="8"
                      markerHeight="8"
                      refX="7"
                      refY="4"
                      orient="auto"
                    >
                      <path
                        d="M0,0 L8,4 L0,8 Z"
                        className={classes.arrowHead}
                      />
                    </marker>
                  </defs>

                  <g
                    data-testid="knowledge-graph-viewport"
                    transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}
                  >
                    {visibleGraph.edges.map((edge) => {
                      const from = positions.get(edge.from);
                      const to = positions.get(edge.to);
                      if (!from || !to) return null;
                      const isActive =
                        activeEdgeId === edge.id ||
                        activeNodeId === edge.from ||
                        activeNodeId === edge.to;

                      return (
                        <g
                          key={edge.id}
                          className={classes.edgeGroup}
                          onMouseEnter={() => setActiveEdgeId(edge.id)}
                          onMouseLeave={() => setActiveEdgeId(null)}
                        >
                          <line
                            x1={from.x}
                            y1={from.y}
                            x2={to.x}
                            y2={to.y}
                            className={`${edgeClassName(edge.type)} ${isActive ? classes.edgeActive : classes.edgeInactive}`}
                            markerEnd="url(#knowledge-graph-arrow)"
                          />
                          <text
                            x={(from.x + to.x) / 2}
                            y={(from.y + to.y) / 2 - 8}
                            className={`${classes.edgeLabel} ${isActive ? classes.edgeLabelVisible : ""}`}
                            data-visible={isActive ? "true" : "false"}
                          >
                            {edge.label}
                          </text>
                        </g>
                      );
                    })}

                    {visibleGraph.nodes.map((node) => {
                      const point = positions.get(node.id);
                      if (!point) return null;
                      const radius = nodeRadius(node);
                      const selected = selectedNodeId === node.id;
                      const showLabel =
                        persistentLabelNodeIds.has(node.id) ||
                        activeNodeId === node.id ||
                        selected;

                      return (
                        <g
                          key={node.id}
                          className={classes.nodeGroup}
                          role="button"
                          tabIndex={0}
                          aria-label={`${t("Graph node")}: ${node.title}`}
                          onPointerDown={(event) =>
                            handleNodePointerDown(event, node.id)
                          }
                          onMouseEnter={() => setActiveNodeId(node.id)}
                          onMouseLeave={() => setActiveNodeId(null)}
                          onClick={() => setSelectedNodeId(node.id)}
                          onDoubleClick={() => focusNode(node)}
                        >
                          <title>
                            {`${node.kind === "section" ? "Section" : "Page"}: ${node.headingPath?.join(" / ") || node.title}`}
                          </title>
                          {node.kind === "section" ? (
                            <rect
                              x={point.x - 54}
                              y={point.y - 16}
                              width={108}
                              height={32}
                              rx={9}
                              className={`${classes.sectionNode} ${selected ? classes.nodeSelected : ""}`}
                            />
                          ) : (
                            <circle
                              cx={point.x}
                              cy={point.y}
                              r={radius}
                              className={`${classes.nodeCircle} ${selected ? classes.nodeSelected : ""}`}
                              style={{ fill: nodeColor(node) }}
                            />
                          )}
                          {showLabel && node.sourcePageId ? (
                            <a href={`/p/${node.sourcePageId}`}>
                              <text
                                x={point.x}
                                y={
                                  node.kind === "section"
                                    ? point.y + 4
                                    : point.y + radius + 18
                                }
                                className={classes.nodeLabel}
                              >
                                {truncateLabel(node.title)}
                              </text>
                            </a>
                          ) : showLabel ? (
                            <text
                              x={point.x}
                              y={
                                node.kind === "section"
                                  ? point.y + 4
                                  : point.y + radius + 18
                              }
                              className={classes.nodeLabel}
                            >
                              {truncateLabel(node.title)}
                            </text>
                          ) : null}
                        </g>
                      );
                    })}
                  </g>
                </svg>
                {selectedNode && (
                  <aside className={classes.nodeDetails}>
                    <Group justify="space-between" wrap="nowrap">
                      <Badge
                        color={
                          selectedNode.kind === "section" ? "violet" : "blue"
                        }
                        variant="light"
                      >
                        {selectedNode.kind === "section"
                          ? t("Section")
                          : t("Wiki page")}
                      </Badge>
                      <ActionIcon
                        variant="subtle"
                        aria-label={t("Close details")}
                        onClick={() => setSelectedNodeId(null)}
                      >
                        <IconX size={16} />
                      </ActionIcon>
                    </Group>
                    <Text fw={700} size="lg" mt="sm">
                      {selectedNode.title}
                    </Text>
                    {selectedNode.headingPath &&
                      selectedNode.headingPath.length > 1 && (
                        <Text size="xs" c="dimmed" mt={4}>
                          {selectedNode.headingPath.join(" / ")}
                        </Text>
                      )}
                    {selectedNode.excerpt && (
                      <Text size="sm" mt="md" className={classes.nodeExcerpt}>
                        {selectedNode.excerpt}
                      </Text>
                    )}
                    <Divider my="md" />
                    <Group gap="xs">
                      <Button
                        size="xs"
                        leftSection={<IconFocus2 size={14} />}
                        onClick={() => focusNode(selectedNode)}
                      >
                        {t("Focus neighborhood")}
                      </Button>
                      {selectedNode.sourcePageId && (
                        <Button
                          component={Link}
                          to={`/p/${selectedNode.sourcePageId}`}
                          size="xs"
                          variant="default"
                          leftSection={<IconFileText size={14} />}
                        >
                          {t("Open page")}
                        </Button>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed" mt="md">
                      {t("Connections")}: {selectedNode.degree}
                    </Text>
                  </aside>
                )}
              </>
            )}
          </section>
        </Stack>
      </Container>
    </>
  );
}

function fitGraphTransform(
  nodes: KnowledgeGraphNode[],
  layout: Map<string, GraphPoint>,
): GraphTransform {
  if (nodes.length === 0) return { x: 0, y: 0, scale: 1 };

  const points = nodes
    .map((node) => layout.get(node.id))
    .filter((point): point is GraphPoint => Boolean(point));

  if (points.length === 0) return { x: 0, y: 0, scale: 1 };

  const padding = 90;
  const minX = Math.min(...points.map((point) => point.x)) - padding;
  const maxX = Math.max(...points.map((point) => point.x)) + padding;
  const minY = Math.min(...points.map((point) => point.y)) - padding;
  const maxY = Math.max(...points.map((point) => point.y)) + padding;
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const scale = clamp(
    Math.min(GRAPH_WIDTH / width, GRAPH_HEIGHT / height),
    MIN_ZOOM,
    1.35,
  );

  return {
    scale,
    x: GRAPH_WIDTH / 2 - ((minX + maxX) / 2) * scale,
    y: GRAPH_HEIGHT / 2 - ((minY + maxY) / 2) * scale,
  };
}

function filterGraph(
  graph: KnowledgeGraphResult,
  search: string,
  edgeTypes: KnowledgeGraphEdge["type"][],
  focusPageId: string | null,
  showIsolated: boolean,
): KnowledgeGraphResult {
  const query = search.trim().toLowerCase();
  const edgeTypeSet = new Set<KnowledgeGraphEdge["type"]>([
    ...edgeTypes,
    "contains",
  ]);
  const allowedEdges = graph.edges.filter((edge) => edgeTypeSet.has(edge.type));
  const relationshipEdges = allowedEdges.filter(
    (edge) => edge.type !== "contains",
  );
  const visibleNodeIds = new Set<string>();

  if (focusPageId) {
    visibleNodeIds.add(focusPageId);
    for (const edge of relationshipEdges) {
      if (edge.from === focusPageId) visibleNodeIds.add(edge.to);
      if (edge.to === focusPageId) visibleNodeIds.add(edge.from);
    }
    for (const node of graph.nodes) {
      if (node.kind === "section" && node.parentPageId === focusPageId) {
        visibleNodeIds.add(node.id);
      }
    }
  } else if (query) {
    for (const node of graph.nodes) {
      const searchable = [
        node.title,
        node.excerpt ?? "",
        ...(node.headingPath ?? []),
      ]
        .join(" ")
        .toLowerCase();
      if (!searchable.includes(query)) continue;
      visibleNodeIds.add(node.id);
      if (node.parentPageId) visibleNodeIds.add(node.parentPageId);
    }
    for (const edge of relationshipEdges) {
      if (
        edge.label.toLowerCase().includes(query) ||
        visibleNodeIds.has(edge.from) ||
        visibleNodeIds.has(edge.to)
      ) {
        visibleNodeIds.add(edge.from);
        visibleNodeIds.add(edge.to);
      }
    }
  } else {
    const relationshipDegree = new Map<string, number>();
    for (const edge of relationshipEdges) {
      relationshipDegree.set(
        edge.from,
        (relationshipDegree.get(edge.from) ?? 0) + 1,
      );
      relationshipDegree.set(
        edge.to,
        (relationshipDegree.get(edge.to) ?? 0) + 1,
      );
    }
    const pageNodes = graph.nodes.filter((node) => node.kind !== "section");
    const connectedPageNodes = pageNodes.filter(
      (node) => (relationshipDegree.get(node.id) ?? 0) > 0,
    );
    const overviewCandidates =
      showIsolated || connectedPageNodes.length === 0
        ? pageNodes
        : connectedPageNodes;
    overviewCandidates
      .sort((a, b) => {
        const degreeDelta =
          (relationshipDegree.get(b.id) ?? 0) -
          (relationshipDegree.get(a.id) ?? 0);
        return degreeDelta || a.title.localeCompare(b.title);
      })
      .slice(0, OVERVIEW_NODE_LIMIT)
      .forEach((node) => visibleNodeIds.add(node.id));
  }

  const nodes = graph.nodes.filter((node) => visibleNodeIds.has(node.id));
  const nodeSet = new Set(nodes.map((node) => node.id));
  const edges = allowedEdges.filter(
    (edge) => nodeSet.has(edge.from) && nodeSet.has(edge.to),
  );

  return {
    nodes,
    edges,
    insights: graph.insights,
  };
}

function edgeClassName(type: KnowledgeGraphEdge["type"]): string {
  if (type === "semantic") return classes.semanticEdge;
  if (type === "contains") return classes.containsEdge;
  return classes.linkEdge;
}

function truncateLabel(value: string): string {
  return value.length > 18 ? `${value.slice(0, 17)}…` : value;
}

const COMMUNITY_COLORS = [
  "var(--mantine-color-blue-6)",
  "var(--mantine-color-teal-6)",
  "var(--mantine-color-violet-6)",
  "var(--mantine-color-orange-6)",
  "var(--mantine-color-cyan-6)",
  "var(--mantine-color-pink-6)",
];

function nodeColor(node: KnowledgeGraphNode): string {
  const key = node.communityId || node.id;
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  return COMMUNITY_COLORS[Math.abs(hash) % COMMUNITY_COLORS.length];
}

function uniqueEdgeTypes(
  edgeTypes: KnowledgeGraphEdge["type"][],
): KnowledgeGraphEdge["type"][] {
  return [...new Set(edgeTypes)];
}

function clientPointToGraphPoint(
  svg: SVGSVGElement | null,
  point: { clientX: number; clientY: number },
): { x: number; y: number } {
  const rect = svg?.getBoundingClientRect();
  if (!rect?.width || !rect.height) return graphCenter();

  return {
    x: ((point.clientX - rect.left) / rect.width) * GRAPH_WIDTH,
    y: ((point.clientY - rect.top) / rect.height) * GRAPH_HEIGHT,
  };
}

function clientPointToWorldPoint(
  svg: SVGSVGElement | null,
  transform: GraphTransform,
  point: { clientX: number; clientY: number },
): GraphPoint {
  const graphPoint = clientPointToGraphPoint(svg, point);
  return {
    x: (graphPoint.x - transform.x) / transform.scale,
    y: (graphPoint.y - transform.y) / transform.scale,
  };
}

function graphCenter(): GraphPoint {
  return { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildInitialGraphLayout(
  nodes: KnowledgeGraphNode[],
  edges: KnowledgeGraphEdge[],
): Map<string, GraphPoint> {
  const connected = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const pageNodes = nodes.filter((node) => node.kind !== "section");
  const sectionNodes = nodes.filter((node) => node.kind === "section");
  const sortedNodes = [...pageNodes].sort((a, b) => {
    const degreeDelta = b.degree - a.degree;
    if (degreeDelta !== 0) return degreeDelta;
    return a.title.localeCompare(b.title);
  });
  const layout = new Map<string, GraphPoint>();
  const centerX = GRAPH_WIDTH / 2;
  const centerY = GRAPH_HEIGHT / 2;
  const connectedNodes = sortedNodes.filter((node) => connected.has(node.id));
  const isolatedNodes = sortedNodes.filter((node) => !connected.has(node.id));

  connectedNodes.forEach((node, index) => {
    const angle = (index / Math.max(connectedNodes.length, 1)) * Math.PI * 2;
    const radius = 120 + (index % 3) * 92;
    layout.set(node.id, {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    });
  });

  isolatedNodes.forEach((node, index) => {
    const columns = 8;
    const column = index % columns;
    const row = Math.floor(index / columns);
    layout.set(node.id, {
      x: 96 + column * 130,
      y: 72 + row * 105,
    });
  });

  const sectionIndexByPage = new Map<string, number>();
  for (const section of sectionNodes) {
    const parentId = section.parentPageId ?? "";
    const parentPoint = layout.get(parentId) ?? graphCenter();
    const sectionIndex = sectionIndexByPage.get(parentId) ?? 0;
    sectionIndexByPage.set(parentId, sectionIndex + 1);
    const angle = sectionIndex * Math.PI * 0.68 - Math.PI * 0.8;
    const ring = 92 + Math.floor(sectionIndex / 7) * 70;
    layout.set(section.id, {
      x: parentPoint.x + Math.cos(angle) * ring,
      y: parentPoint.y + Math.sin(angle) * ring,
    });
  }

  return layout;
}

function initializeSimulation(
  nodes: KnowledgeGraphNode[],
  layout: Map<string, GraphPoint>,
): Map<string, SimulatedNode> {
  const positions = new Map<string, SimulatedNode>();
  for (const node of nodes) {
    const point = layout.get(node.id) ?? graphCenter();
    positions.set(node.id, {
      x: point.x,
      y: point.y,
      vx: 0,
      vy: 0,
      degree: node.degree,
      kind: node.kind,
    });
  }
  return positions;
}

function simulateGraphStep(input: {
  current: Map<string, SimulatedNode>;
  edges: KnowledgeGraphEdge[];
  width: number;
  height: number;
}): Map<string, SimulatedNode> {
  const next = clonePositions(input.current);
  const nodes = [...next.entries()];

  for (let i = 0; i < nodes.length; i += 1) {
    const [, a] = nodes[i];
    for (let j = i + 1; j < nodes.length; j += 1) {
      const [, b] = nodes[j];
      const dx = b.x - a.x || 0.01;
      const dy = b.y - a.y || 0.01;
      const distance = Math.max(Math.hypot(dx, dy), 1);
      const distanceSq = Math.max(distance * distance, 1600);
      const force = 5200 / distanceSq;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;

      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  for (const edge of input.edges) {
    const from = next.get(edge.from);
    const to = next.get(edge.to);
    if (!from || !to) continue;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.max(Math.hypot(dx, dy), 1);
    const targetDistance =
      edge.type === "semantic" ? 175 : edge.type === "contains" ? 92 : 125;
    const force = (distance - targetDistance) * 0.014;
    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;

    from.vx += fx;
    from.vy += fy;
    to.vx -= fx;
    to.vy -= fy;
  }

  const center = graphCenter();
  for (const [, node] of nodes) {
    node.vx += (center.x - node.x) * 0.002;
    node.vy += (center.y - node.y) * 0.002;
    const margin = 72;
    if (node.x < margin) node.vx += (margin - node.x) * 0.018;
    if (node.x > input.width - margin) {
      node.vx -= (node.x - (input.width - margin)) * 0.018;
    }
    if (node.y < margin) node.vy += (margin - node.y) * 0.018;
    if (node.y > input.height - margin) {
      node.vy -= (node.y - (input.height - margin)) * 0.018;
    }
    node.vx *= 0.78;
    node.vy *= 0.78;
    node.x = clamp(node.x + node.vx, 36, input.width - 36);
    node.y = clamp(node.y + node.vy, 36, input.height - 36);
  }

  return next;
}

function clonePositions(
  positions: Map<string, SimulatedNode>,
): Map<string, SimulatedNode> {
  return new Map(
    [...positions.entries()].map(([id, node]) => [id, { ...node }]),
  );
}

function nodeRadius(node: KnowledgeGraphNode): number {
  if (node.kind === "section") return 18;
  return Math.min(22, 9 + node.degree * 2);
}
