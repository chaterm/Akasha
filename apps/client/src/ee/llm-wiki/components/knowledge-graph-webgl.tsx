import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { drawSquareNodeLabel, NodeSquareProgram } from "@sigma/node-square";
import { MultiDirectedGraph } from "graphology";
import { inferSettings } from "graphology-layout-forceatlas2";
import ForceAtlas2Layout from "graphology-layout-forceatlas2/worker";
import Sigma from "sigma";
import {
  drawDiscNodeHover,
  drawDiscNodeLabel,
  EdgeArrowProgram,
  type NodeHoverDrawingFunction,
} from "sigma/rendering";
import classes from "../styles/knowledge-graph.module.css";
import type {
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
} from "../types/knowledge.types";

type WebglNodeAttributes = {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
  type: "circle" | "square";
  kind: KnowledgeGraphNode["kind"];
};

type WebglEdgeAttributes = {
  type: "arrow";
  relationType: KnowledgeGraphEdge["type"];
  color: string;
  size: number;
  label: string;
};
type MotionNode = {
  id: string;
  x: number;
  y: number;
  color: string;
  kind: KnowledgeGraphNode["kind"];
};
type MotionEdge = {
  source: MotionNode;
  target: MotionNode;
};

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const POSITION_BUCKETS = 1_000_003;
const POSITION_SPREAD = 2;
const SECTION_COLOR = "#845ef7";
const COMMUNITY_COLORS = [
  "#228be6",
  "#12b886",
  "#7950f2",
  "#fd7e14",
  "#15aabf",
  "#e64980",
];
const EDGE_COLORS: Record<KnowledgeGraphEdge["type"], string> = {
  link: "#c7ced6",
  semantic: "#a9dfc0",
  contains: "#d8ccff",
};
const EDGE_SIZES: Record<KnowledgeGraphEdge["type"], number> = {
  link: 0.45,
  semantic: 0.65,
  contains: 0.4,
};

const HOVER_EDGE_COLORS: Record<KnowledgeGraphEdge["type"], string> = {
  link: "#6b7280",
  semantic: "#22c55e",
  contains: SECTION_COLOR,
};
const HOVER_EDGE_SIZES: Record<KnowledgeGraphEdge["type"], number> = {
  link: 1.2,
  semantic: 1.35,
  contains: 1.1,
};
const HOLLOW_DIAMOND_VERTEX_SHADER = /* glsl */ `
attribute vec4 a_id;
attribute vec4 a_color;
attribute vec2 a_position;
attribute float a_size;
attribute float a_angle;

uniform mat3 u_matrix;
uniform mediump float u_sizeRatio;
uniform float u_cameraAngle;
uniform float u_correctionRatio;

varying vec4 v_color;
varying vec2 v_localPosition;

const float bias = 255.0 / 254.0;
const float sqrt_8 = sqrt(8.0);
const float shadowMargin = 1.4;

void main() {
  float size = a_size * u_correctionRatio / u_sizeRatio * sqrt_8 * shadowMargin;
  float angle = a_angle + u_cameraAngle;
  vec2 diffVector = size * vec2(cos(angle), sin(angle));
  vec2 position = a_position + diffVector;
  gl_Position = vec4((u_matrix * vec3(position, 1)).xy, 0, 1);
  v_localPosition = vec2(cos(a_angle), sin(a_angle)) * shadowMargin;

  #ifdef PICKING_MODE
  v_color = a_id;
  #else
  v_color = a_color;
  #endif

  v_color.a *= bias;
}
`;

const HOLLOW_DIAMOND_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;
uniform mediump float u_sizeRatio;


varying vec4 v_color;
varying vec2 v_localPosition;

float roundedBoxDistance(vec2 point, vec2 halfSize, float radius) {
  vec2 delta = abs(point) - halfSize + vec2(radius);
  return length(max(delta, vec2(0.0))) +
    min(max(delta.x, delta.y), 0.0) -
    radius;
}

void main(void) {
  const float rotation = 0.70710678;
  vec2 point = vec2(
    (v_localPosition.x - v_localPosition.y) * rotation,
    (v_localPosition.x + v_localPosition.y) * rotation
  );
  float distance = roundedBoxDistance(point, vec2(0.68), 0.28);

  #ifdef PICKING_MODE
  if (distance > 0.0) discard;
  gl_FragColor = v_color;
  #else
  vec3 selectedColor = vec3(0.961, 0.624, 0.0);
  float selectedMix =
    1.0 - step(0.08, length(v_color.rgb - selectedColor));
  vec3 fillColor = vec3(0.953, 0.941, 1.0);
  vec3 defaultShadowColor = vec3(0.353, 0.216, 0.706);
  vec3 shadowColor = mix(defaultShadowColor, v_color.rgb, selectedMix);
  float shadowExtent = mix(0.22, 0.30, selectedMix);
  if (distance > shadowExtent) discard;

  float zoomedOut = smoothstep(0.6, 0.9, u_sizeRatio);
  float shadowStrength =
    mix(0.18, 0.35, selectedMix) * (1.0 - zoomedOut);
  float shadowAlpha =
    (1.0 - smoothstep(0.0, shadowExtent, max(distance, 0.0))) *
    shadowStrength;
  float borderInner = mix(-0.2, -0.23, selectedMix);
  borderInner = mix(borderInner, -0.055, zoomedOut);
  float borderMix = smoothstep(borderInner, -0.035, distance);
  vec3 shapeColor = mix(fillColor, v_color.rgb, borderMix);
  vec3 farColor = mix(
    fillColor,
    v_color.rgb,
    0.45 + selectedMix * 0.55
  );
  shapeColor = mix(shapeColor, farColor, zoomedOut);

  float antialiasWidth = mix(0.018, 0.05, zoomedOut);
  float shapeCoverage =
    1.0 - smoothstep(-antialiasWidth, antialiasWidth, distance);
  float shapeAlpha = shapeCoverage * v_color.a;
  float haloAlpha = shadowAlpha * (1.0 - shapeCoverage) * v_color.a;
  float alpha = shapeAlpha + haloAlpha;
  if (alpha <= 0.001) discard;
  vec3 premultipliedColor =
    shapeColor * shapeAlpha + shadowColor * haloAlpha;
  gl_FragColor = vec4(premultipliedColor, alpha);
  #endif
}
`;

export class NodeHollowDiamondProgram extends NodeSquareProgram {
  override drawHover = drawSquareNodeLabel;

  override getDefinition() {
    return {
      ...super.getDefinition(),
      VERTEX_SHADER_SOURCE: HOLLOW_DIAMOND_VERTEX_SHADER,
      FRAGMENT_SHADER_SOURCE: HOLLOW_DIAMOND_FRAGMENT_SHADER,
      CONSTANT_DATA: [
        [0],
        [Math.PI / 2],
        [-Math.PI / 2],
        [Math.PI / 2],
        [Math.PI],
        [-Math.PI / 2],
      ],
    };
  }
}
export type KnowledgeGraphWebglHandle = {
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
};

type KnowledgeGraphWebglProps = {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  selectedNodeId: string | null;
  onSelectNode(nodeId: string | null): void;
  onFocusNode(node: KnowledgeGraphNode): void;
};

const CAMERA_ANIMATION_DURATION = 180;
const INITIAL_CAMERA_RATIO = 0.12;
const LAYOUT_DURATION = 4_000;
const CONTAINS_EDGE_HIDE_RATIO = 0.7;
const SELECTED_NODE_COLOR = "#f59f00";
const MOTION_FRAME_INTERVAL = 50;
const MOTION_NODE_HIDE_RATIO = 0.35;
const CAMERA_IDLE_DELAY = 120;
const VIEWPORT_MARGIN = 48;

const drawSelectedNodeHover: NodeHoverDrawingFunction = (
  context,
  data,
  settings,
) => {
  if (!data.highlighted) {
    drawDiscNodeHover(context, data, settings);
    return;
  }

  context.save();
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  context.shadowBlur = 7;
  context.shadowColor = "rgba(245, 159, 0, 0.35)";
  context.fillStyle = SELECTED_NODE_COLOR;
  context.beginPath();
  context.arc(data.x, data.y, data.size + 4, 0, Math.PI * 2);
  context.fill();

  context.shadowBlur = 0;
  context.fillStyle = data.color;
  context.beginPath();
  context.arc(data.x, data.y, data.size, 0, Math.PI * 2);
  context.fill();
  context.restore();
  drawDiscNodeLabel(context, data, settings);
};

const KnowledgeGraphWebgl = forwardRef<
  KnowledgeGraphWebglHandle,
  KnowledgeGraphWebglProps
>(function KnowledgeGraphWebgl(
  { nodes, edges, selectedNodeId, onSelectNode, onFocusNode },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<Sigma<
    WebglNodeAttributes,
    WebglEdgeAttributes
  > | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const selectedNodeIdRef = useRef(selectedNodeId);
  const previousSelectedNodeIdRef = useRef(selectedNodeId);
  const cameraRatioRef = useRef(1);
  const onSelectNodeRef = useRef(onSelectNode);
  const onFocusNodeRef = useRef(onFocusNode);

  selectedNodeIdRef.current = selectedNodeId;
  onSelectNodeRef.current = onSelectNode;
  onFocusNodeRef.current = onFocusNode;

  useImperativeHandle(
    ref,
    () => ({
      zoomIn() {
        void rendererRef.current
          ?.getCamera()
          .animatedZoom({ duration: CAMERA_ANIMATION_DURATION });
      },
      zoomOut() {
        void rendererRef.current
          ?.getCamera()
          .animatedUnzoom({ duration: CAMERA_ANIMATION_DURATION });
      },
      fit() {
        void rendererRef.current
          ?.getCamera()
          .animatedReset({ duration: CAMERA_ANIMATION_DURATION });
      },
    }),
    [],
  );

  useEffect(() => {
    const previousSelectedNodeId = previousSelectedNodeIdRef.current;
    previousSelectedNodeIdRef.current = selectedNodeId;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const graph = renderer.getGraph();
    const nodeIds = [
      ...new Set([previousSelectedNodeId, selectedNodeId]),
    ].filter(
      (nodeId): nodeId is string => nodeId !== null && graph.hasNode(nodeId),
    );
    if (nodeIds.length === 0) return;

    renderer.refresh({
      partialGraph: { nodes: nodeIds },
      schedule: true,
      skipIndexation: true,
    });
  }, [selectedNodeId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const graph = createWebglGraph(nodes, edges);
    const containsEdgeIds = edges
      .filter((edge) => edge.type === "contains" && graph.hasEdge(edge.id))
      .map((edge) => edge.id);
    let hoveredNodeId: string | null = null;
    const renderer = new Sigma<WebglNodeAttributes, WebglEdgeAttributes>(
      graph,
      container,
      {
        hideEdgesOnMove: true,
        hideLabelsOnMove: true,
        renderEdgeLabels: true,
        labelDensity: 0.08,
        labelGridCellSize: 120,
        labelRenderedSizeThreshold: 8,
        minCameraRatio: 0.03,
        maxCameraRatio: 3.2,
        nodeProgramClasses: {
          square: NodeHollowDiamondProgram,
        },
        edgeProgramClasses: {
          arrow: EdgeArrowProgram,
        },
        defaultDrawNodeHover: drawSelectedNodeHover,
        nodeReducer: (node, data) => {
          if (node !== selectedNodeIdRef.current) return { ...data };
          if (data.type === "square") {
            return {
              ...data,
              color: SELECTED_NODE_COLOR,
              highlighted: true,
            };
          }
          return { ...data, highlighted: true };
        },
        edgeReducer: (edge, data) => {
          const isHoveredEdge =
            hoveredNodeId !== null && graph.hasExtremity(edge, hoveredNodeId);
          return {
            ...data,
            color: isHoveredEdge
              ? HOVER_EDGE_COLORS[data.relationType]
              : data.color,
            size: isHoveredEdge
              ? HOVER_EDGE_SIZES[data.relationType]
              : data.size,
            label: isHoveredEdge ? data.label : "",
            forceLabel: isHoveredEdge,
            hidden:
              !isHoveredEdge &&
              data.relationType === "contains" &&
              cameraRatioRef.current > CONTAINS_EDGE_HIDE_RATIO,
          };
        },
      },
    );
    rendererRef.current = renderer;

    const camera = renderer.getCamera();
    const focusNode = findInitialFocusNode(nodes);
    let cameraTouched = false;
    let programmaticCameraUpdate = false;
    const overlay = overlayRef.current;
    const context = overlay?.getContext("2d") ?? null;
    let overlayWidth = 0;
    let overlayHeight = 0;
    let visibleNodes: MotionNode[] = [];
    let visibleContainsEdges: MotionEdge[] = [];
    let cameraIdleTimer: number | null = null;
    let motionFrame: number | null = null;
    let lastMotionDraw = 0;
    let layoutRunning = true;
    let cameraMoving = true;

    const clearMotionOverlay = () => {
      if (!context || overlayWidth === 0 || overlayHeight === 0) return;
      context.clearRect(0, 0, overlayWidth, overlayHeight);
    };
    const refreshVisibleNodes = () => {
      const dimensions = renderer.getDimensions();
      const width = overlayWidth || dimensions.width;
      const height = overlayHeight || dimensions.height;
      const next: MotionNode[] = [];
      const nextById = new Map<string, MotionNode>();
      graph.forEachNode((id, attributes) => {
        const point = renderer.graphToViewport({
          x: attributes.x,
          y: attributes.y,
        });
        if (
          point.x < -VIEWPORT_MARGIN ||
          point.x > width + VIEWPORT_MARGIN ||
          point.y < -VIEWPORT_MARGIN ||
          point.y > height + VIEWPORT_MARGIN
        ) {
          return;
        }
        const node = {
          id,
          x: point.x,
          y: point.y,
          color: attributes.color,
          kind: attributes.kind,
        };
        next.push(node);
        nextById.set(id, node);
      });
      const nextContainsEdges: MotionEdge[] = [];
      const seenEdges = new Set<string>();
      for (const node of next) {
        for (const edge of graph.edges(node.id)) {
          if (seenEdges.has(edge)) continue;
          seenEdges.add(edge);
          if (graph.getEdgeAttribute(edge, "relationType") !== "contains") {
            continue;
          }
          const source = nextById.get(graph.source(edge));
          const target = nextById.get(graph.target(edge));
          if (source && target) nextContainsEdges.push({ source, target });
        }
      }
      visibleNodes = next;
      visibleContainsEdges = nextContainsEdges;
      cameraMoving = false;
    };
    const scheduleVisibleNodes = () => {
      if (document.hidden) return;
      cameraMoving = true;
      if (cameraIdleTimer !== null) window.clearTimeout(cameraIdleTimer);
      cameraIdleTimer = window.setTimeout(() => {
        cameraIdleTimer = null;
        refreshVisibleNodes();
      }, CAMERA_IDLE_DELAY);
    };
    const resizeObserver =
      overlay && context && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(([entry]) => {
            if (!entry) return;
            overlayWidth = entry.contentRect.width;
            overlayHeight = entry.contentRect.height;
            const pixelRatio = window.devicePixelRatio || 1;
            overlay.width = Math.max(1, Math.round(overlayWidth * pixelRatio));
            overlay.height = Math.max(
              1,
              Math.round(overlayHeight * pixelRatio),
            );
            context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            if (!layoutRunning) scheduleVisibleNodes();
          })
        : null;
    resizeObserver?.observe(container);

    const drawMotion = (time: number) => {
      if (
        context &&
        !layoutRunning &&
        !cameraMoving &&
        !document.hidden &&
        time - lastMotionDraw >= MOTION_FRAME_INTERVAL
      ) {
        lastMotionDraw = time;
        clearMotionOverlay();
        if (cameraRatioRef.current <= CONTAINS_EDGE_HIDE_RATIO) {
          context.setLineDash([4, 4]);
          for (const edge of visibleContainsEdges) {
            const emphasized =
              hoveredNodeId === edge.source.id ||
              hoveredNodeId === edge.target.id;
            context.globalAlpha = emphasized ? 0.68 : 0.3;
            context.strokeStyle = emphasized
              ? HOVER_EDGE_COLORS.contains
              : EDGE_COLORS.contains;
            context.lineWidth = emphasized ? 1.4 : 0.8;
            context.beginPath();
            context.moveTo(edge.source.x, edge.source.y);
            context.lineTo(edge.target.x, edge.target.y);
            context.stroke();
          }
          context.setLineDash([]);
        }
        if (cameraRatioRef.current <= MOTION_NODE_HIDE_RATIO) {
          for (const node of visibleNodes) {
            if (node.kind === "section") continue;
            const phase = (hashId(node.id) % 360) * (Math.PI / 180);
            const pulse = 0.5 + Math.sin(time / 900 + phase) * 0.5;
            context.globalAlpha = 0.18 + pulse * 0.18;
            context.beginPath();
            context.arc(node.x, node.y, 8 + pulse * 2.5, 0, Math.PI * 2);
            context.strokeStyle = node.color;
            context.lineWidth = 1.2 + pulse * 0.8;
            context.stroke();
          }
        }
        context.globalAlpha = 1;
      }
      motionFrame = window.requestAnimationFrame(drawMotion);
    };
    const startMotion = () => {
      if (!context || motionFrame !== null || document.hidden) return;
      motionFrame = window.requestAnimationFrame(drawMotion);
    };
    const stopMotion = () => {
      if (motionFrame === null) return;
      window.cancelAnimationFrame(motionFrame);
      motionFrame = null;
    };
    const handleVisibilityChange = () => {
      clearMotionOverlay();
      cameraMoving = true;
      if (document.hidden) {
        if (cameraIdleTimer !== null) {
          window.clearTimeout(cameraIdleTimer);
          cameraIdleTimer = null;
        }
        stopMotion();
        return;
      }
      if (!layoutRunning) scheduleVisibleNodes();
      startMotion();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    cameraRatioRef.current = camera.getState().ratio;
    const focusCamera = () => {
      if (!focusNode) return;
      const displayData = renderer.getNodeDisplayData(focusNode.id);
      if (!displayData) return;
      programmaticCameraUpdate = true;
      try {
        camera.setState({
          x: displayData.x,
          y: displayData.y,
          ratio: INITIAL_CAMERA_RATIO,
        });
      } finally {
        programmaticCameraUpdate = false;
      }
    };
    const handleCameraUpdate = (state: { ratio: number }) => {
      const containsEdgesWereHidden =
        cameraRatioRef.current > CONTAINS_EDGE_HIDE_RATIO;
      const containsEdgesAreHidden = state.ratio > CONTAINS_EDGE_HIDE_RATIO;
      cameraRatioRef.current = state.ratio;
      if (!programmaticCameraUpdate) cameraTouched = true;
      if (
        containsEdgesWereHidden !== containsEdgesAreHidden &&
        containsEdgeIds.length > 0
      ) {
        renderer.refresh({
          partialGraph: { edges: containsEdgeIds },
          schedule: true,
          skipIndexation: true,
        });
      }
      clearMotionOverlay();
      if (!layoutRunning) scheduleVisibleNodes();
    };
    camera.on("updated", handleCameraUpdate);

    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const updateHoveredNode = (nodeId: string | null) => {
      const changedEdges = new Set<string>();
      for (const id of [hoveredNodeId, nodeId]) {
        if (!id || !graph.hasNode(id)) continue;
        for (const edge of graph.edges(id)) changedEdges.add(edge);
      }
      hoveredNodeId = nodeId;
      if (changedEdges.size === 0) return;
      renderer.refresh({
        partialGraph: { edges: [...changedEdges] },
        schedule: true,
        skipIndexation: true,
      });
    };
    const handleEnterNode = ({ node }: { node: string }) => {
      updateHoveredNode(node);
    };
    const handleLeaveNode = ({ node }: { node: string }) => {
      if (node === hoveredNodeId) updateHoveredNode(null);
    };
    const handleClickNode = ({ node }: { node: string }) => {
      onSelectNodeRef.current(node);
    };
    const handleClickStage = () => {
      onSelectNodeRef.current(null);
    };
    const handleDoubleClickNode = ({
      node,
      preventSigmaDefault,
    }: {
      node: string;
      preventSigmaDefault(): void;
    }) => {
      preventSigmaDefault();
      const originalNode = nodesById.get(node);
      if (originalNode) onFocusNodeRef.current(originalNode);
    };
    renderer.on("enterNode", handleEnterNode);
    renderer.on("leaveNode", handleLeaveNode);
    renderer.on("clickNode", handleClickNode);
    renderer.on("clickStage", handleClickStage);
    renderer.on("doubleClickNode", handleDoubleClickNode);

    const layout = new ForceAtlas2Layout(graph, {
      settings: inferSettings(graph),
    });
    const stopLayout = () => {
      if (!layoutRunning) return;
      layoutRunning = false;
      layout.stop();
    };
    layout.start();

    const stopTimer = window.setTimeout(() => {
      stopLayout();
      scheduleVisibleNodes();
    }, LAYOUT_DURATION);
    const initialFrame = window.requestAnimationFrame(() => {
      if (!cameraTouched) focusCamera();
    });
    startMotion();

    return () => {
      window.clearTimeout(stopTimer);
      if (cameraIdleTimer !== null) window.clearTimeout(cameraIdleTimer);
      window.cancelAnimationFrame(initialFrame);
      stopMotion();
      resizeObserver?.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      camera.off("updated", handleCameraUpdate);
      renderer.off("enterNode", handleEnterNode);
      renderer.off("leaveNode", handleLeaveNode);
      renderer.off("clickNode", handleClickNode);
      renderer.off("clickStage", handleClickStage);
      renderer.off("doubleClickNode", handleDoubleClickNode);
      stopLayout();
      layout.kill();
      renderer.kill();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [edges, nodes]);

  return (
    <div
      data-testid="knowledge-graph-webgl"
      className={classes.graphWebgl}
      style={{
        width: "100%",
        height: "100%",
        minHeight: "0",
        position: "relative",
      }}
    >
      <div
        ref={containerRef}
        style={{ position: "absolute", inset: 0, minHeight: 0 }}
      />
      <canvas
        ref={overlayRef}
        className={classes.graphMotionOverlay}
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />
    </div>
  );
});

export default KnowledgeGraphWebgl;

function findInitialFocusNode(
  nodes: KnowledgeGraphNode[],
): KnowledgeGraphNode | undefined {
  let highestPage: KnowledgeGraphNode | undefined;
  let highestNode: KnowledgeGraphNode | undefined;

  for (const node of nodes) {
    if (!highestNode || node.degree > highestNode.degree) highestNode = node;
    if (
      node.kind === "page" &&
      (!highestPage || node.degree > highestPage.degree)
    ) {
      highestPage = node;
    }
  }

  return highestPage ?? highestNode;
}

export function createWebglGraph(
  nodes: KnowledgeGraphNode[],
  edges: KnowledgeGraphEdge[],
): MultiDirectedGraph<WebglNodeAttributes, WebglEdgeAttributes> {
  const graph = new MultiDirectedGraph<
    WebglNodeAttributes,
    WebglEdgeAttributes
  >();

  nodes.forEach((node) => {
    const angle =
      (hashId(`${node.id}:angle`) % POSITION_BUCKETS) * GOLDEN_ANGLE;
    const radius =
      Math.sqrt((hashId(`${node.id}:radius`) % POSITION_BUCKETS) + 1) *
      POSITION_SPREAD;
    const isSection = node.kind === "section";

    graph.addNode(node.id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      size: isSection
        ? 3
        : Math.max(3.5, Math.min(8, 3.5 + Math.sqrt(node.degree) * 0.6)),
      color: isSection ? SECTION_COLOR : colorFor(node.communityId ?? node.id),
      label: node.title,
      type: isSection ? "square" : "circle",
      kind: node.kind,
    });
  });

  for (const edge of edges) {
    if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue;

    graph.addDirectedEdgeWithKey(edge.id, edge.from, edge.to, {
      type: "arrow",
      relationType: edge.type,
      color: EDGE_COLORS[edge.type],
      label: edge.label,
      size: EDGE_SIZES[edge.type],
    });
  }

  return graph;
}

function hashId(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

function colorFor(value: string): string {
  return COMMUNITY_COLORS[hashId(value) % COMMUNITY_COLORS.length];
}
