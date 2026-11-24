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
import { useDebouncedValue } from "@mantine/hooks";
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
import KnowledgeGraphWebgl, {
  type KnowledgeGraphWebglHandle,
} from "../components/knowledge-graph-webgl";
import type {
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeGraphResult,
} from "../types/knowledge.types";
import classes from "../styles/knowledge-graph.module.css";
import { getErrorMessage } from "@/lib/errors";

const SPACE_LIST_LIMIT = 2_036;
const HIGH_DENSITY_NODE_THRESHOLD = 240;
const GRAPH_WIDTH = 1600;
const COMPACT_SVG_NODE_THRESHOLD = 24;
const GRAPH_HEIGHT = 680;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 3.2;
const ZOOM_STEP = 1.2;
const SECTION_MARKER_SIZE = 18;
const SECTION_CARD_HEIGHT = 32;
const ENABLE_GRAPH_ANIMATION = import.meta.env.MODE !== "test";
const SEARCH_DEBOUNCE_MS = import.meta.env.MODE === "test" ? 0 : 250;
const SIMULATION_ALPHA_DECAY = 0.04;
const SIMULATION_ALPHA_MIN = 0.005;
const SIMULATION_MAX_TICKS = 240;
const SIMULATION_REHEAT_ALPHA = 0.35;
const LAYOUT_PADDING = 72;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const NODE_SPACING = 66;
const MIN_LAYOUT_RADIUS = 160;
const RADIAL_BOUNDARY_PULL = 0.05;
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
  visualHalfWidth: number;
  visualHalfHeight: number;
  collisionRadius: number;
};

export default function KnowledgeGraphPage() {
  const { t } = useTranslation();
  const { spaceSlug } = useParams();
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
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
    limit: SPACE_LIST_LIMIT,
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
    queryFn: () => getKnowledgeGraph({ spaceId: spaceId as string }),
    enabled: Boolean(spaceId),
  });

  const graph = graphQuery.data ?? EMPTY_GRAPH;
  const selectedNode = useMemo(
    () => graph.nodes.find((node) => node.id === selectedNodeId),
    [graph.nodes, selectedNodeId],
  );
  const visibleGraph = useMemo(
    () =>
      filterGraph(graph, debouncedSearch, edgeTypes, focusPageId, showIsolated),
    [edgeTypes, focusPageId, graph, debouncedSearch, showIsolated],
  );
  const graphCounts = useMemo(() => {
    let visiblePageCount = 0;
    let visibleSectionCount = 0;
    for (const node of visibleGraph.nodes) {
      if (node.kind === "section") visibleSectionCount += 1;
      else visiblePageCount += 1;
    }
    let visibleLinkCount = 0;
    let visibleSemanticCount = 0;
    for (const edge of visibleGraph.edges) {
      if (edge.type === "link") visibleLinkCount += 1;
      else if (edge.type === "semantic") visibleSemanticCount += 1;
    }
    return {
      visiblePageCount,
      visibleSectionCount,
      visibleLinkCount,
      visibleSemanticCount,
    };
  }, [visibleGraph.edges, visibleGraph.nodes]);
  const totalPageCount = useMemo(
    () => graph.nodes.reduce((a, n) => (n.kind === "section" ? a : a + 1), 0),
    [graph.nodes],
  );
  const { visiblePageCount } = graphCounts;
  const useHighDensityRenderer =
    graph.nodes.length > HIGH_DENSITY_NODE_THRESHOLD &&
    visibleGraph.nodes.length > COMPACT_SVG_NODE_THRESHOLD;
  const persistentLabelNodeIds = useMemo(() => {
    if (useHighDensityRenderer) return new Set<string>();
    if (
      focusPageId ||
      visibleGraph.nodes.length <= COMPACT_SVG_NODE_THRESHOLD
    ) {
      return new Set(visibleGraph.nodes.map((node) => node.id));
    }
    return new Set(
      [...visibleGraph.nodes]
        .sort((a, b) => b.degree - a.degree)
        .slice(0, 16)
        .map((node) => node.id),
    );
  }, [focusPageId, useHighDensityRenderer, visibleGraph.nodes]);
  const initialLayout = useMemo(
    () =>
      useHighDensityRenderer
        ? new Map<string, GraphPoint>()
        : buildInitialGraphLayout(
            visibleGraph.nodes,
            visibleGraph.edges,
            Boolean(focusPageId),
          ),
    [
      focusPageId,
      useHighDensityRenderer,
      visibleGraph.nodes,
      visibleGraph.edges,
    ],
  );
  const webglRef = useRef<KnowledgeGraphWebglHandle | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const simulationTickRef = useRef(0);
  const simulationAlphaRef = useRef(1);
  const [positions, setPositions] = useState<Map<string, SimulatedNode>>(() =>
    useHighDensityRenderer
      ? new Map()
      : initializeSimulation(
          visibleGraph.nodes,
          initialLayout,
          Boolean(focusPageId),
        ),
  );
  const positionsRef = useRef(positions);
  const [transform, setTransform] = useState<GraphTransform>(() =>
    useHighDensityRenderer
      ? { x: 0, y: 0, scale: 1 }
      : fitGraphTransform(visibleGraph.nodes, initialLayout),
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
    if (useHighDensityRenderer) {
      webglRef.current?.fit();
      return;
    }
    setTransform(fitGraphTransform(visibleGraph.nodes, positions));
  }, [positions, useHighDensityRenderer, visibleGraph.nodes]);

  useEffect(() => {
    simulationTickRef.current = 0;
    simulationAlphaRef.current = 1;
    if (useHighDensityRenderer) {
      positionsRef.current = new Map();
      setPositions(new Map());
      return;
    }
    const nextPositions = initializeSimulation(
      visibleGraph.nodes,
      initialLayout,
      Boolean(focusPageId),
    );
    positionsRef.current = nextPositions;
    setPositions(nextPositions);
    setTransform(fitGraphTransform(visibleGraph.nodes, initialLayout));
  }, [focusPageId, initialLayout, useHighDensityRenderer, visibleGraph.nodes]);

  useEffect(() => {
    if (!ENABLE_GRAPH_ANIMATION || useHighDensityRenderer) return;

    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
    }

    const extent = layoutExtent(positionsRef.current.size);
    const animate = () => {
      if (nodeDragState) {
        animationRef.current = requestAnimationFrame(animate);
        return;
      }

      const alpha = simulationAlphaRef.current;
      const nextPositions = simulateGraphStep({
        current: positionsRef.current,
        edges: visibleGraph.edges,
        width: extent.width,
        height: extent.height,
        alpha,
      });
      positionsRef.current = nextPositions;
      simulationAlphaRef.current = alpha - alpha * SIMULATION_ALPHA_DECAY;
      simulationTickRef.current += 1;
      setPositions(nextPositions);

      if (
        simulationAlphaRef.current > SIMULATION_ALPHA_MIN &&
        simulationTickRef.current < SIMULATION_MAX_TICKS
      ) {
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
  }, [
    nodeDragState,
    positions.size,
    useHighDensityRenderer,
    visibleGraph.edges,
  ]);

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
    (event: WheelEvent<Element>) => {
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
          positionsRef.current = next;
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
    setNodeDragState((current) => {
      if (current) {
        simulationTickRef.current = 0;
        simulationAlphaRef.current = SIMULATION_REHEAT_ALPHA;
      }
      return null;
    });
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
                to={spaceSlug ? `/s/${spaceSlug}` : "/ai"}
                variant="default"
                leftSection={<IconArrowLeft size={16} />}
              >
                {spaceSlug ? t("Space") : t("AI Q&A")}
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
              {t("Pages")}: {visiblePageCount}
              {visiblePageCount < totalPageCount ? ` / ${totalPageCount}` : ""}
            </Badge>
            <Badge variant="light" color="violet">
              {t("Sections")}: {graphCounts.visibleSectionCount}
            </Badge>
            <Badge variant="light">
              {t("Links")}: {graphCounts.visibleLinkCount}
            </Badge>
            <Badge variant="light" color="green">
              {t("Semantic")}: {graphCounts.visibleSemanticCount}
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
              {getErrorMessage(graphQuery.error, "Failed to load data", { withDetail: true })}
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
                      onClick={() =>
                        useHighDensityRenderer
                          ? webglRef.current?.zoomOut()
                          : zoomAt(1 / ZOOM_STEP)
                      }
                    >
                      <IconZoomOut size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label={t("Zoom in")}>
                    <ActionIcon
                      variant="default"
                      aria-label={t("Zoom in")}
                      onClick={() =>
                        useHighDensityRenderer
                          ? webglRef.current?.zoomIn()
                          : zoomAt(ZOOM_STEP)
                      }
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
                {useHighDensityRenderer ? (
                  <KnowledgeGraphWebgl
                    ref={webglRef}
                    nodes={visibleGraph.nodes}
                    edges={visibleGraph.edges}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={setSelectedNodeId}
                    onFocusNode={focusNode}
                  />
                ) : (
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
                        const line = clipEdgeLine(from, to);
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
                              data-edge-id={edge.id}
                              x1={line.x1}
                              y1={line.y1}
                              x2={line.x2}
                              y2={line.y2}
                              className={`${edgeClassName(edge.type)} ${isActive ? classes.edgeActive : classes.edgeInactive}`}
                              markerEnd="url(#knowledge-graph-arrow)"
                            />
                            <text
                              x={(line.x1 + line.x2) / 2}
                              y={(line.y1 + line.y2) / 2 - 8}
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
                        const expandedSection =
                          node.kind === "section" && Boolean(focusPageId);
                        const sectionWidth = sectionCardWidth(node.title);
                        const labelY =
                          node.kind !== "section"
                            ? point.y + radius + 18
                            : expandedSection
                              ? point.y + 4
                              : point.y + SECTION_MARKER_SIZE / 2 + 18;
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
                            data-section-mode={
                              node.kind === "section"
                                ? expandedSection
                                  ? "expanded"
                                  : "compact"
                                : undefined
                            }
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
                            {expandedSection ? (
                              <rect
                                x={point.x - sectionWidth / 2}
                                y={point.y - SECTION_CARD_HEIGHT / 2}
                                width={sectionWidth}
                                height={SECTION_CARD_HEIGHT}
                                rx={9}
                                className={`${classes.sectionNode} ${selected ? classes.nodeSelected : ""}`}
                              />
                            ) : node.kind === "section" ? (
                              <rect
                                x={point.x - SECTION_MARKER_SIZE / 2}
                                y={point.y - SECTION_MARKER_SIZE / 2}
                                width={SECTION_MARKER_SIZE}
                                height={SECTION_MARKER_SIZE}
                                rx={4}
                                transform={`rotate(45 ${point.x} ${point.y})`}
                                className={`${classes.sectionMarker} ${selected ? classes.nodeSelected : ""}`}
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
                                  y={labelY}
                                  className={classes.nodeLabel}
                                >
                                  {truncateLabel(node.title)}
                                </text>
                              </a>
                            ) : showLabel ? (
                              <text
                                x={point.x}
                                y={labelY}
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
                )}
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

  let seen = 0;
  let boundsMinX = Number.POSITIVE_INFINITY;
  let boundsMaxX = Number.NEGATIVE_INFINITY;
  let boundsMinY = Number.POSITIVE_INFINITY;
  let boundsMaxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const point = layout.get(node.id);
    if (!point) continue;
    seen += 1;
    if (point.x < boundsMinX) boundsMinX = point.x;
    if (point.x > boundsMaxX) boundsMaxX = point.x;
    if (point.y < boundsMinY) boundsMinY = point.y;
    if (point.y > boundsMaxY) boundsMaxY = point.y;
  }

  if (seen === 0) return { x: 0, y: 0, scale: 1 };

  const padding = 90;
  const minX = boundsMinX - padding;
  const maxX = boundsMaxX + padding;
  const minY = boundsMinY - padding;
  const maxY = boundsMaxY + padding;
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
    for (const node of overviewCandidates) visibleNodeIds.add(node.id);
    for (const node of graph.nodes) {
      if (
        node.kind === "section" &&
        node.parentPageId &&
        visibleNodeIds.has(node.parentPageId)
      ) {
        visibleNodeIds.add(node.id);
      }
    }
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
  element: Element | null,
  point: { clientX: number; clientY: number },
): { x: number; y: number } {
  const rect = element?.getBoundingClientRect();
  if (!rect?.width || !rect.height) return graphCenter();

  return {
    x: ((point.clientX - rect.left) / rect.width) * GRAPH_WIDTH,
    y: ((point.clientY - rect.top) / rect.height) * GRAPH_HEIGHT,
  };
}

function clientPointToWorldPoint(
  element: Element | null,
  transform: GraphTransform,
  point: { clientX: number; clientY: number },
): GraphPoint {
  const graphPoint = clientPointToGraphPoint(element, point);
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

export function layoutExtent(nodeCount: number): {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  radius: number;
} {
  const radius = Math.max(
    MIN_LAYOUT_RADIUS,
    Math.sqrt(Math.max(nodeCount, 1) / Math.PI) * NODE_SPACING,
  );
  const side = Math.max(GRAPH_HEIGHT, radius * 2 + LAYOUT_PADDING * 2);
  return {
    width: side,
    height: side,
    centerX: side / 2,
    centerY: side / 2,
    radius,
  };
}

function buildInitialGraphLayout(
  nodes: KnowledgeGraphNode[],
  edges: KnowledgeGraphEdge[],
  expandedSections = false,
): Map<string, GraphPoint> {
  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  const pageNodes = nodes.filter((node) => node.kind !== "section");
  const sectionNodes = nodes.filter((node) => node.kind === "section");
  const sortedNodes = [...pageNodes].sort((a, b) => {
    const connectedDelta =
      Number(connected.has(b.id)) - Number(connected.has(a.id));
    if (connectedDelta !== 0) return connectedDelta;
    const degreeDelta = b.degree - a.degree;
    if (degreeDelta !== 0) return degreeDelta;
    return a.title.localeCompare(b.title);
  });
  const layout = new Map<string, GraphPoint>();
  const extent = layoutExtent(nodes.length);

  sortedNodes.forEach((node, index) => {
    const angle = index * GOLDEN_ANGLE;
    const radius =
      Math.sqrt((index + 0.5) / Math.max(sortedNodes.length, 1)) *
      extent.radius;
    layout.set(node.id, {
      x: extent.centerX + Math.cos(angle) * radius,
      y: extent.centerY + Math.sin(angle) * radius,
    });
  });

  const sectionIndexByPage = new Map<string, number>();
  for (const section of sectionNodes) {
    const parentId = section.parentPageId ?? "";
    const parentPoint =
      layout.get(parentId) ?? ({ x: extent.centerX, y: extent.centerY } as const);
    const sectionIndex = sectionIndexByPage.get(parentId) ?? 0;
    sectionIndexByPage.set(parentId, sectionIndex + 1);
    const angle = sectionIndex * GOLDEN_ANGLE;
    const ring =
      (expandedSections ? 138 : 76) + Math.floor(sectionIndex / 7) * 70;
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
  expandedSections = false,
): Map<string, SimulatedNode> {
  const positions = new Map<string, SimulatedNode>();
  for (const node of nodes) {
    const point = layout.get(node.id) ?? graphCenter();
    const dimensions = nodeVisualDimensions(node, expandedSections);
    positions.set(node.id, {
      x: point.x,
      y: point.y,
      vx: 0,
      vy: 0,
      degree: node.degree,
      kind: node.kind,
      visualHalfWidth: dimensions.halfWidth,
      visualHalfHeight: dimensions.halfHeight,
      collisionRadius:
        Math.hypot(dimensions.halfWidth, dimensions.halfHeight) + 10,
    });
  }
  return positions;
}

function simulateGraphStep(input: {
  current: Map<string, SimulatedNode>;
  edges: KnowledgeGraphEdge[];
  width: number;
  height: number;
  alpha?: number;
}): Map<string, SimulatedNode> {
  const next = clonePositions(input.current);
  const alpha = input.alpha ?? 1;
  const nodes = [...next.values()];

  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      const dx = b.x - a.x || 0.01;
      const dy = b.y - a.y || 0.01;
      const distance = Math.max(Math.hypot(dx, dy), 1);
      const distanceSq = Math.max(distance * distance, 1600);
      const minimumDistance = a.collisionRadius + b.collisionRadius;
      const overlapForce =
        distance < minimumDistance ? (minimumDistance - distance) * 0.065 : 0;
      const force = (5200 / distanceSq + overlapForce) * alpha;
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
      edge.type === "semantic" ? 175 : edge.type === "contains" ? 110 : 125;
    const force = (distance - targetDistance) * 0.014 * alpha;
    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;

    from.vx += fx;
    from.vy += fy;
    to.vx -= fx;
    to.vy -= fy;
  }

  const centerX = input.width / 2;
  const centerY = input.height / 2;
  const boundaryRadius = Math.min(input.width, input.height) / 2;
  for (const node of nodes) {
    node.vx += (centerX - node.x) * 0.002 * alpha;
    node.vy += (centerY - node.y) * 0.002 * alpha;

    const offsetX = node.x - centerX;
    const offsetY = node.y - centerY;
    const distance = Math.hypot(offsetX, offsetY);
    const limit =
      boundaryRadius - Math.max(node.visualHalfWidth, node.visualHalfHeight) - 8;
    if (distance > limit && distance > 0) {
      const unitX = offsetX / distance;
      const unitY = offsetY / distance;
      const overshoot = distance - limit;
      node.vx -= unitX * overshoot * RADIAL_BOUNDARY_PULL * alpha;
      node.vy -= unitY * overshoot * RADIAL_BOUNDARY_PULL * alpha;
    }

    node.vx *= 0.78;
    node.vy *= 0.78;
    node.x += node.vx;
    node.y += node.vy;

    const nextOffsetX = node.x - centerX;
    const nextOffsetY = node.y - centerY;
    const nextDistance = Math.hypot(nextOffsetX, nextOffsetY);
    if (nextDistance > limit && nextDistance > 0) {
      const scale = limit / nextDistance;
      node.x = centerX + nextOffsetX * scale;
      node.y = centerY + nextOffsetY * scale;
    }
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

function sectionCardWidth(title: string): number {
  const textWidth = [...title].reduce(
    (width, character) =>
      width + (/^[\u0000-\u00ff]$/.test(character) ? 7 : 14),
    0,
  );
  return clamp(textWidth + 28, 108, 220);
}

function nodeVisualDimensions(
  node: KnowledgeGraphNode,
  expandedSections: boolean,
): { halfWidth: number; halfHeight: number } {
  if (node.kind !== "section") {
    const radius = nodeRadius(node);
    return { halfWidth: radius, halfHeight: radius };
  }
  if (expandedSections) {
    return {
      halfWidth: sectionCardWidth(node.title) / 2,
      halfHeight: SECTION_CARD_HEIGHT / 2,
    };
  }
  const markerRadius = (SECTION_MARKER_SIZE * Math.SQRT2) / 2;
  return { halfWidth: markerRadius, halfHeight: markerRadius };
}

function clipEdgeLine(
  from: SimulatedNode,
  to: SimulatedNode,
): { x1: number; y1: number; x2: number; y2: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.max(Math.hypot(dx, dy), 1);
  const unitX = dx / distance;
  const unitY = dy / distance;
  const fromOffset = boundaryOffset(from, unitX, unitY) + 2;
  const toOffset = boundaryOffset(to, unitX, unitY) + 7;
  if (fromOffset + toOffset >= distance) {
    return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  }
  return {
    x1: from.x + unitX * fromOffset,
    y1: from.y + unitY * fromOffset,
    x2: to.x - unitX * toOffset,
    y2: to.y - unitY * toOffset,
  };
}

function boundaryOffset(
  node: SimulatedNode,
  unitX: number,
  unitY: number,
): number {
  const horizontal = unitX / Math.max(node.visualHalfWidth, 1);
  const vertical = unitY / Math.max(node.visualHalfHeight, 1);
  return 1 / Math.max(Math.hypot(horizontal, vertical), 0.001);
}
