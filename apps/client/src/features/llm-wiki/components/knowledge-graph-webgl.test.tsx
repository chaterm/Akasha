import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { Settings } from "sigma/settings";
import type {
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
} from "../types/knowledge.types";
import KnowledgeGraphWebgl, {
  createWebglGraph,
  type KnowledgeGraphWebglHandle,
  NodeHollowDiamondProgram,
} from "./knowledge-graph-webgl";

type SigmaListener = (payload: {
  node?: string;
  preventSigmaDefault?: () => void;
}) => void;

const sigmaMocks = vi.hoisted(() => {
  const NodeSquareProgram = class NodeSquareProgram {
    getDefinition() {
      return {
        VERTICES: 6,
        VERTEX_SHADER_SOURCE: "base vertex",
        FRAGMENT_SHADER_SOURCE: "base fragment",
        CONSTANT_DATA: [],
      };
    }
  };
  const EdgeArrowProgram = class EdgeArrowProgram {};
  const drawSquareNodeLabel = vi.fn();
  const drawDiscNodeHover = vi.fn();
  const drawDiscNodeLabel = vi.fn();
  const instances: Array<{
    graph: {
      getNodeAttributes(node: string): { x: number; y: number };
      hasNode(node: string): boolean;
    };
    settings: Record<string, unknown>;
    listeners: Map<string, SigmaListener>;
    cameraListeners: Map<
      string,
      (state: { x: number; y: number; angle: number; ratio: number }) => void
    >;
    camera: {
      getState: ReturnType<typeof vi.fn>;
      setState: Mock<
        (
          state: Partial<{
            x: number;
            y: number;
            angle: number;
            ratio: number;
          }>,
        ) => void
      >;
      animatedZoom: ReturnType<typeof vi.fn>;
      animatedUnzoom: ReturnType<typeof vi.fn>;
      animatedReset: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      off: ReturnType<typeof vi.fn>;
    };
    renderer: {
      on: ReturnType<typeof vi.fn>;
      off: ReturnType<typeof vi.fn>;
      getCamera: ReturnType<typeof vi.fn>;
      getGraph: ReturnType<typeof vi.fn>;
      getNodeDisplayData: ReturnType<typeof vi.fn>;
      getDimensions: ReturnType<typeof vi.fn>;
      graphToViewport: ReturnType<typeof vi.fn>;
      refresh: ReturnType<typeof vi.fn>;
      kill: ReturnType<typeof vi.fn>;
    };
  }> = [];

  const Sigma = vi.fn(function Sigma(
    graph: {
      getNodeAttributes(node: string): { x: number; y: number };
      hasNode(node: string): boolean;
    },
    _container: HTMLElement,
    settings: Record<string, unknown>,
  ) {
    const listeners = new Map<string, SigmaListener>();
    const cameraListeners = new Map<
      string,
      (state: { x: number; y: number; angle: number; ratio: number }) => void
    >();
    let cameraState = { x: 0.5, y: 0.5, angle: 0, ratio: 1 };
    const camera = {
      getState: vi.fn(() => cameraState),
      setState: vi.fn((state: Partial<typeof cameraState>) => {
        cameraState = { ...cameraState, ...state };
        cameraListeners.get("updated")?.(cameraState);
      }),
      animatedZoom: vi.fn(() => Promise.resolve()),
      animatedUnzoom: vi.fn(() => Promise.resolve()),
      animatedReset: vi.fn(() => Promise.resolve()),
      on: vi.fn(
        (
          event: string,
          listener: (state: {
            x: number;
            y: number;
            angle: number;
            ratio: number;
          }) => void,
        ) => {
          cameraListeners.set(event, listener);
        },
      ),
      off: vi.fn((event: string) => {
        cameraListeners.delete(event);
      }),
    };
    const renderer = {
      on: vi.fn((event: string, listener: SigmaListener) => {
        listeners.set(event, listener);
        return renderer;
      }),
      off: vi.fn((event: string) => {
        listeners.delete(event);
        return renderer;
      }),
      getCamera: vi.fn(() => camera),
      getGraph: vi.fn(() => graph),
      getNodeDisplayData: vi.fn((node: string) =>
        graph.getNodeAttributes(node),
      ),
      getDimensions: vi.fn(() => ({ width: 800, height: 500 })),
      graphToViewport: vi.fn(() => ({ x: 100, y: 100 })),
      refresh: vi.fn(() => renderer),
      kill: vi.fn(),
    };
    instances.push({
      graph,
      settings,
      listeners,
      cameraListeners,
      camera,
      renderer,
    });
    return renderer;
  });

  return {
    drawDiscNodeHover,
    drawDiscNodeLabel,
    drawSquareNodeLabel,
    EdgeArrowProgram,
    instances,
    NodeSquareProgram,
    Sigma,
  };
});

const forceAtlasMocks = vi.hoisted(() => {
  const inferredSettings = { barnesHutOptimize: true, slowDown: 4 };
  const inferSettings = vi.fn(() => inferredSettings);
  const instances: Array<{
    graph: unknown;
    params: unknown;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  }> = [];
  const Worker = vi.fn(function Worker(graph: unknown, params: unknown) {
    const instance = {
      graph,
      params,
      start: vi.fn(),
      stop: vi.fn(),
      kill: vi.fn(),
    };
    instances.push(instance);
    return instance;
  });

  return { inferredSettings, inferSettings, instances, Worker };
});

vi.mock("sigma", () => ({ default: sigmaMocks.Sigma }));
vi.mock("sigma/rendering", () => ({
  drawDiscNodeHover: sigmaMocks.drawDiscNodeHover,
  drawDiscNodeLabel: sigmaMocks.drawDiscNodeLabel,
  EdgeArrowProgram: sigmaMocks.EdgeArrowProgram,
}));
vi.mock("@sigma/node-square", () => ({
  NodeSquareProgram: sigmaMocks.NodeSquareProgram,
  drawSquareNodeLabel: sigmaMocks.drawSquareNodeLabel,
}));
vi.mock("graphology-layout-forceatlas2", () => ({
  inferSettings: forceAtlasMocks.inferSettings,
}));
vi.mock("graphology-layout-forceatlas2/worker", () => ({
  default: forceAtlasMocks.Worker,
}));

let animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrameId = 1;
let overlayContext: {
  setTransform: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  setLineDash: ReturnType<typeof vi.fn>;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
};
let resizeObserverDisconnects: Array<ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  sigmaMocks.instances.length = 0;
  forceAtlasMocks.instances.length = 0;
  animationFrames = new Map();
  nextAnimationFrameId = 1;
  resizeObserverDisconnects = [];
  overlayContext = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    overlayContext as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal("devicePixelRatio", 2);
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserverMock {
      disconnect = vi.fn();
      unobserve = vi.fn();
      observe: ReturnType<typeof vi.fn>;

      constructor(callback: ResizeObserverCallback) {
        resizeObserverDisconnects.push(this.disconnect);
        this.observe = vi.fn((target: Element) => {
          callback(
            [
              {
                target,
                contentRect: { width: 800, height: 500 },
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        });
      }
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextAnimationFrameId++;
      animationFrames.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      animationFrames.delete(id);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createWebglGraph", () => {
  it("keeps 10,000 nodes and parallel edge relations", () => {
    const nodes: KnowledgeGraphNode[] = [
      ...Array.from({ length: 9_999 }, (_, index) => ({
        id: `page-${index}`,
        title: `Page ${index}`,
        spaceId: "space-1",
        kind: "page" as const,
        degree: 1,
        communityId: `community-${index % 6}`,
      })),
      {
        id: "section-1",
        title: "Section 1",
        spaceId: "space-1",
        kind: "section",
        parentPageId: "page-0",
        degree: 1,
      },
    ];
    const edges: KnowledgeGraphEdge[] = [
      {
        id: "link-1",
        from: "page-0",
        to: "page-1",
        type: "link",
        label: "references",
        weight: 1,
        reasons: ["direct-link"],
      },
      {
        id: "semantic-1",
        from: "page-0",
        to: "page-1",
        type: "semantic",
        label: "related",
        weight: 0.9,
        reasons: ["semantic-edge"],
      },
      {
        id: "contains-1",
        from: "page-0",
        to: "section-1",
        type: "contains",
        label: "contains section",
        weight: 1,
        reasons: ["section-membership"],
      },
      {
        id: "invalid-1",
        from: "page-0",
        to: "missing-page",
        type: "contains",
        label: "contains",
        weight: 1,
        reasons: ["missing-endpoint"],
      },
    ];

    const graph = createWebglGraph(nodes, edges);
    const reversedGraph = createWebglGraph([...nodes].reverse(), edges);

    expect(graph.order).toBe(10_000);
    expect(graph.getNodeAttribute("section-1", "type")).toBe("square");
    expect(graph.getNodeAttribute("section-1", "size")).toBe(3);
    expect(graph.getNodeAttribute("section-1", "color")).toBe("#845ef7");
    expect(graph.getNodeAttribute("page-0", "type")).toBe("circle");
    expect(graph.getNodeAttribute("page-0", "size")).toBeCloseTo(4.1);
    expect(graph.getNodeAttribute("page-100", "size")).toBeLessThanOrEqual(8);
    expect(reversedGraph.getNodeAttribute("page-100", "x")).toBe(
      graph.getNodeAttribute("page-100", "x"),
    );
    expect(reversedGraph.getNodeAttribute("page-100", "y")).toBe(
      graph.getNodeAttribute("page-100", "y"),
    );
    expect(graph.size).toBe(3);
    expect(graph.hasEdge("link-1")).toBe(true);
    expect(graph.hasEdge("semantic-1")).toBe(true);
    expect(graph.source("link-1")).toBe("page-0");
    expect(graph.target("link-1")).toBe("page-1");
    expect(graph.getEdgeAttribute("link-1", "relationType")).toBe("link");
    expect(graph.getEdgeAttribute("link-1", "label")).toBe("references");
    expect(graph.getEdgeAttribute("link-1", "color")).toBe("#c7ced6");
    expect(graph.getEdgeAttribute("link-1", "size")).toBe(0.45);
    expect(graph.source("semantic-1")).toBe("page-0");
    expect(graph.target("semantic-1")).toBe("page-1");
    expect(graph.getEdgeAttribute("semantic-1", "relationType")).toBe(
      "semantic",
    );
    expect(graph.getEdgeAttribute("semantic-1", "color")).toBe("#a9dfc0");
    expect(graph.getEdgeAttribute("semantic-1", "size")).toBe(0.65);
    expect(graph.getEdgeAttribute("contains-1", "color")).toBe("#d8ccff");
    expect(graph.getEdgeAttribute("contains-1", "size")).toBe(0.4);
  });
});

describe("NodeHollowDiamondProgram", () => {
  it("matches the SVG marker gradients in default and selected states", () => {
    const definition = NodeHollowDiamondProgram.prototype.getDefinition();
    const Program = NodeHollowDiamondProgram as unknown as new () => {
      drawHover: unknown;
    };
    const program = new Program();

    expect(definition.VERTICES).toBe(6);
    expect(definition.CONSTANT_DATA).toEqual([
      [0],
      [Math.PI / 2],
      [-Math.PI / 2],
      [Math.PI / 2],
      [Math.PI],
      [-Math.PI / 2],
    ]);
    expect(definition.VERTEX_SHADER_SOURCE).toContain("v_localPosition");
    expect(definition.VERTEX_SHADER_SOURCE).toContain("shadowMargin = 1.4");
    expect(definition.VERTEX_SHADER_SOURCE).toContain(
      "uniform mediump float u_sizeRatio",
    );
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain("PICKING_MODE");
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain(
      "uniform mediump float u_sizeRatio",
    );
    expect(program.drawHover).toBe(sigmaMocks.drawSquareNodeLabel);
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain("roundedBoxDistance");
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain(
      "roundedBoxDistance(point, vec2(0.68), 0.28)",
    );
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain("fillColor");
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain("defaultShadowColor");
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain(
      "mix(defaultShadowColor, v_color.rgb, selectedMix)",
    );
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain("selectedMix");
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain("shadowStrength");
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain("shadowExtent");
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain("zoomedOut");
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain("shapeCoverage");
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain("haloAlpha");
    expect(definition.FRAGMENT_SHADER_SOURCE).not.toContain(
      "if (distance > 0.0) {",
    );
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain("borderInner");
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain(
      "mix(borderInner, -0.055, zoomedOut)",
    );
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain(
      "mix(-0.2, -0.23, selectedMix)",
    );
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain(
      "shapeColor * shapeAlpha + shadowColor * haloAlpha",
    );
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain("shadowAlpha");
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain("smoothstep");
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain(
      "mix(fillColor, v_color.rgb, borderMix)",
    );
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain("farColor");
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain(
      "mix(shapeColor, farColor, zoomedOut)",
    );
    expect(definition.FRAGMENT_SHADER_SOURCE).not.toContain("glowAlpha");
    expect(definition.FRAGMENT_SHADER_SOURCE).not.toContain("gradientMix");
    expect(definition.FRAGMENT_SHADER_SOURCE).toContain("discard");
  });
});

describe("KnowledgeGraphWebgl", () => {
  it("fills its parent so Sigma receives a non-zero graph viewport", () => {
    const view = render(
      <KnowledgeGraphWebgl
        nodes={buildLargeGraphNodes()}
        edges={[]}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
        onFocusNode={vi.fn()}
      />,
    );

    expect(view.getByTestId("knowledge-graph-webgl").style).toMatchObject({
      width: "100%",
      height: "100%",
      minHeight: "0",
      position: "relative",
    });
  });

  it("owns the Sigma and ForceAtlas2 lifecycle for a 501-node graph", () => {
    const nodes = buildLargeGraphNodes();
    const edges: KnowledgeGraphEdge[] = [
      {
        id: "contains-1",
        from: "page-anchor",
        to: "section-high",
        type: "contains",
        label: "contains",
        weight: 1,
        reasons: ["section-membership"],
      },
    ];
    const view = render(
      <KnowledgeGraphWebgl
        nodes={nodes}
        edges={edges}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
        onFocusNode={vi.fn()}
      />,
    );

    expect(sigmaMocks.Sigma).toHaveBeenCalledTimes(1);
    expect(forceAtlasMocks.Worker).toHaveBeenCalledTimes(1);
    const sigma = sigmaMocks.instances[0];
    const worker = forceAtlasMocks.instances[0];
    const settings = sigma.settings as Partial<Settings>;

    expect(settings).toMatchObject({
      hideEdgesOnMove: true,
      hideLabelsOnMove: true,
      renderEdgeLabels: true,
      labelDensity: 0.08,
      labelGridCellSize: 120,
      labelRenderedSizeThreshold: 8,
      minCameraRatio: 0.03,
      maxCameraRatio: 3.2,
    });
    expect(settings.nodeProgramClasses?.square).toBe(NodeHollowDiamondProgram);
    expect(settings.edgeProgramClasses?.arrow).toBe(
      sigmaMocks.EdgeArrowProgram,
    );
    expect(forceAtlasMocks.inferSettings).toHaveBeenCalledWith(sigma.graph);
    expect(worker.graph).toBe(sigma.graph);
    expect(worker.params).toEqual({
      settings: forceAtlasMocks.inferredSettings,
    });
    expect(worker.start).toHaveBeenCalledTimes(1);

    sigma.renderer.getNodeDisplayData.mockImplementation((node: string) =>
      node === "page-anchor" ? { x: 0.73, y: 0.31 } : { x: 0.1, y: 0.2 },
    );
    runNextAnimationFrame();

    expect(sigma.renderer.getNodeDisplayData).toHaveBeenCalledWith(
      "page-anchor",
    );
    expect(sigma.camera.setState).toHaveBeenCalledWith({
      x: 0.73,
      y: 0.31,
      ratio: 0.12,
    });

    act(() => {
      vi.advanceTimersByTime(3_999);
    });
    expect(worker.stop).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(sigma.camera.setState).toHaveBeenCalledTimes(1);

    view.unmount();

    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(worker.kill).toHaveBeenCalledTimes(1);
    expect(sigma.renderer.kill).toHaveBeenCalledTimes(1);
    expect(sigma.camera.off).toHaveBeenCalledWith(
      "updated",
      expect.any(Function),
    );
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it("falls back to the highest-degree node when no page exists", () => {
    render(
      <KnowledgeGraphWebgl
        nodes={[
          {
            id: "section-low",
            title: "Low",
            spaceId: "space-1",
            kind: "section",
            degree: 2,
          },
          {
            id: "section-high",
            title: "High",
            spaceId: "space-1",
            kind: "section",
            degree: 9,
          },
        ]}
        edges={[]}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
        onFocusNode={vi.fn()}
      />,
    );

    runNextAnimationFrame();

    expect(
      sigmaMocks.instances[0].renderer.getNodeDisplayData,
    ).toHaveBeenCalledWith("section-high");
  });

  it("exposes camera controls and forwards graph interactions", () => {
    const ref = createRef<KnowledgeGraphWebglHandle>();
    const onSelectNode = vi.fn();
    const onFocusNode = vi.fn();
    const nodes = buildLargeGraphNodes();

    render(
      <KnowledgeGraphWebgl
        ref={ref}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        onSelectNode={onSelectNode}
        onFocusNode={onFocusNode}
      />,
    );

    const sigma = sigmaMocks.instances[0];
    act(() => {
      ref.current?.zoomIn();
      ref.current?.zoomOut();
      ref.current?.fit();
    });

    expect(sigma.camera.animatedZoom).toHaveBeenCalledWith({ duration: 180 });
    expect(sigma.camera.animatedUnzoom).toHaveBeenCalledWith({ duration: 180 });
    expect(sigma.camera.animatedReset).toHaveBeenCalledWith({ duration: 180 });

    act(() => {
      sigma.listeners.get("clickNode")?.({ node: "page-anchor" });
      sigma.listeners.get("clickStage")?.({});
    });
    expect(onSelectNode).toHaveBeenNthCalledWith(1, "page-anchor");
    expect(onSelectNode).toHaveBeenNthCalledWith(2, null);

    const preventSigmaDefault = vi.fn();
    act(() => {
      sigma.listeners.get("doubleClickNode")?.({
        node: "page-anchor",
        preventSigmaDefault,
      });
    });
    expect(preventSigmaDefault).toHaveBeenCalledTimes(1);
    expect(onFocusNode).toHaveBeenCalledWith(nodes[1]);
  });

  it("emphasizes only hovered incident edges and restores quiet styling", () => {
    const edges: KnowledgeGraphEdge[] = [
      {
        id: "link-1",
        from: "page-anchor",
        to: "page-0",
        type: "link",
        label: "links",
        weight: 1,
        reasons: ["direct-link"],
      },
      {
        id: "semantic-1",
        from: "page-0",
        to: "page-1",
        type: "semantic",
        label: "related",
        weight: 1,
        reasons: ["semantic-edge"],
      },
      {
        id: "contains-1",
        from: "page-anchor",
        to: "section-high",
        type: "contains",
        label: "contains",
        weight: 1,
        reasons: ["section-membership"],
      },
    ];
    const view = render(
      <KnowledgeGraphWebgl
        nodes={buildLargeGraphNodes()}
        edges={edges}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
        onFocusNode={vi.fn()}
      />,
    );
    const sigma = sigmaMocks.instances[0];
    const edgeReducer = (sigma.settings as Partial<Settings>)
      .edgeReducer as NonNullable<Settings["edgeReducer"]>;
    const linkData = {
      type: "arrow",
      relationType: "link",
      label: "links",
      color: "#c7ced6",
      size: 0.45,
    };
    const semanticData = {
      type: "arrow",
      relationType: "semantic",
      label: "related",
      color: "#a9dfc0",
      size: 0.65,
    };

    expect(edgeReducer("link-1", linkData)).toEqual({
      ...linkData,
      label: "",
      forceLabel: false,
      hidden: false,
    });

    sigma.renderer.refresh.mockClear();
    act(() => {
      sigma.listeners.get("enterNode")?.({ node: "page-anchor" });
    });

    expect(sigma.renderer.refresh).toHaveBeenCalledTimes(1);
    const hoveredEdges = sigma.renderer.refresh.mock.calls[0][0].partialGraph
      .edges as string[];
    expect(hoveredEdges).toHaveLength(2);
    expect(hoveredEdges).toEqual(
      expect.arrayContaining(["link-1", "contains-1"]),
    );
    expect(edgeReducer("link-1", linkData)).toEqual({
      ...linkData,
      color: "#6b7280",
      size: 1.2,
      label: "links",
      forceLabel: true,
      hidden: false,
    });
    expect(edgeReducer("semantic-1", semanticData)).toEqual({
      ...semanticData,
      label: "",
      forceLabel: false,
      hidden: false,
    });

    act(() => {
      sigma.listeners.get("leaveNode")?.({ node: "page-anchor" });
    });

    expect(sigma.renderer.refresh).toHaveBeenCalledTimes(2);
    expect(edgeReducer("link-1", linkData)).toEqual({
      ...linkData,
      label: "",
      forceLabel: false,
      hidden: false,
    });

    view.unmount();
    expect(sigma.renderer.off).toHaveBeenCalledWith(
      "enterNode",
      expect.any(Function),
    );
    expect(sigma.renderer.off).toHaveBeenCalledWith(
      "leaveNode",
      expect.any(Function),
    );
  });

  it("refreshes contains edges only when camera LOD crosses the threshold", () => {
    const edges: KnowledgeGraphEdge[] = [
      {
        id: "contains-1",
        from: "page-anchor",
        to: "section-high",
        type: "contains",
        label: "contains",
        weight: 1,
        reasons: ["section-membership"],
      },
      {
        id: "contains-2",
        from: "page-0",
        to: "section-high",
        type: "contains",
        label: "contains",
        weight: 1,
        reasons: ["section-membership"],
      },
      {
        id: "link-1",
        from: "page-0",
        to: "page-anchor",
        type: "link",
        label: "links",
        weight: 1,
        reasons: ["direct-link"],
      },
    ];
    render(
      <KnowledgeGraphWebgl
        nodes={buildLargeGraphNodes()}
        edges={edges}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
        onFocusNode={vi.fn()}
      />,
    );
    const sigma = sigmaMocks.instances[0];
    const updateCamera = sigma.cameraListeners.get("updated");

    sigma.renderer.refresh.mockClear();
    act(() => {
      updateCamera?.({ x: 0.5, y: 0.5, angle: 0, ratio: 0.9 });
    });
    expect(sigma.renderer.refresh).not.toHaveBeenCalled();

    act(() => {
      updateCamera?.({ x: 0.5, y: 0.5, angle: 0, ratio: 0.6 });
      updateCamera?.({ x: 0.5, y: 0.5, angle: 0, ratio: 0.5 });
    });
    expect(sigma.renderer.refresh).toHaveBeenCalledTimes(1);
    expect(sigma.renderer.refresh).toHaveBeenNthCalledWith(1, {
      partialGraph: { edges: ["contains-1", "contains-2"] },
      schedule: true,
      skipIndexation: true,
    });

    act(() => {
      updateCamera?.({ x: 0.5, y: 0.5, angle: 0, ratio: 0.8 });
      updateCamera?.({ x: 0.5, y: 0.5, angle: 0, ratio: 0.9 });
    });
    expect(sigma.renderer.refresh).toHaveBeenCalledTimes(2);
    expect(sigma.renderer.refresh).toHaveBeenNthCalledWith(2, {
      partialGraph: { edges: ["contains-1", "contains-2"] },
      schedule: true,
      skipIndexation: true,
    });
  });

  it("keeps the initial camera when the layout timer stops", () => {
    render(
      <KnowledgeGraphWebgl
        nodes={buildLargeGraphNodes()}
        edges={[]}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
        onFocusNode={vi.fn()}
      />,
    );
    const sigma = sigmaMocks.instances[0];
    const worker = forceAtlasMocks.instances[0];
    sigma.renderer.getNodeDisplayData
      .mockReturnValueOnce({ x: 0.2, y: 0.3 })
      .mockReturnValue({ x: 0.81, y: 0.64 });

    runNextAnimationFrame();
    expect(sigma.camera.setState).toHaveBeenLastCalledWith({
      x: 0.2,
      y: 0.3,
      ratio: 0.12,
    });

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(sigma.renderer.getNodeDisplayData).toHaveBeenCalledTimes(1);
    expect(sigma.camera.setState).toHaveBeenCalledTimes(1);
  });

  it("does not refocus at layout stop after the user moves the camera", () => {
    render(
      <KnowledgeGraphWebgl
        nodes={buildLargeGraphNodes()}
        edges={[]}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
        onFocusNode={vi.fn()}
      />,
    );
    const sigma = sigmaMocks.instances[0];

    runNextAnimationFrame();
    act(() => {
      sigma.camera.setState({
        x: 0.8,
        y: 0.7,
        angle: 0,
        ratio: 0.35,
      });
    });
    sigma.camera.setState.mockClear();
    sigma.renderer.getNodeDisplayData.mockClear();

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(sigma.camera.setState).not.toHaveBeenCalled();
    expect(sigma.renderer.getNodeDisplayData).not.toHaveBeenCalled();
  });

  it("updates selection and LOD reducers without rebuilding resources", () => {
    const nodes = buildLargeGraphNodes();
    const edges: KnowledgeGraphEdge[] = [];
    const view = render(
      <KnowledgeGraphWebgl
        nodes={nodes}
        edges={edges}
        selectedNodeId="page-anchor"
        onSelectNode={vi.fn()}
        onFocusNode={vi.fn()}
      />,
    );
    const sigma = sigmaMocks.instances[0];
    const settings = sigma.settings as Partial<Settings>;
    const nodeReducer = settings.nodeReducer as NonNullable<
      Settings["nodeReducer"]
    >;
    const edgeReducer = settings.edgeReducer as NonNullable<
      Settings["edgeReducer"]
    >;

    expect(
      nodeReducer("page-anchor", {
        x: 0,
        y: 0,
        label: "Anchor",
        type: "circle",
        size: 10,
        color: "#228be6",
      }),
    ).toEqual({
      x: 0,
      y: 0,
      label: "Anchor",
      type: "circle",
      size: 10,
      color: "#228be6",
      highlighted: true,
    });
    expect(
      nodeReducer("page-0", {
        x: 0,
        y: 0,
        label: "Other",
        type: "circle",
        size: 10,
        color: "#228be6",
      }),
    ).toEqual({
      x: 0,
      y: 0,
      label: "Other",
      type: "circle",
      size: 10,
      color: "#228be6",
    });

    const drawHover = settings.defaultDrawNodeHover;
    expect(drawHover).toBeTypeOf("function");
    const fillStyles: string[] = [];
    let fillStyle = "";
    const hoverContext = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      shadowBlur: 0,
      shadowColor: "",
    };
    Object.defineProperty(hoverContext, "fillStyle", {
      get: () => fillStyle,
      set: (value: string) => {
        fillStyle = value;
        fillStyles.push(value);
      },
    });
    drawHover?.(
      hoverContext as unknown as CanvasRenderingContext2D,
      {
        x: 20,
        y: 30,
        size: 12,
        label: "Anchor",
        color: "#228be6",
        highlighted: true,
      },
      settings as Settings,
    );
    expect(hoverContext.arc).toHaveBeenNthCalledWith(
      1,
      20,
      30,
      16,
      0,
      Math.PI * 2,
    );
    expect(hoverContext.arc).toHaveBeenNthCalledWith(
      2,
      20,
      30,
      12,
      0,
      Math.PI * 2,
    );
    expect(fillStyles).toEqual(["#f59f00", "#228be6"]);
    expect(sigmaMocks.drawDiscNodeHover).not.toHaveBeenCalled();
    expect(sigmaMocks.drawDiscNodeLabel).toHaveBeenCalledTimes(1);

    sigma.cameraListeners.get("updated")?.({
      x: 0.5,
      y: 0.5,
      angle: 0,
      ratio: 0.8,
    });
    expect(
      edgeReducer("contains-1", {
        type: "arrow",
        relationType: "contains",
        label: "contains",
        color: "#d8ccff",
        size: 0.4,
      }),
    ).toEqual({
      type: "arrow",
      relationType: "contains",
      label: "",
      color: "#d8ccff",
      size: 0.4,
      forceLabel: false,
      hidden: true,
    });
    expect(
      edgeReducer("link-1", {
        type: "arrow",
        relationType: "link",
        label: "links",
        color: "#c7ced6",
        size: 0.45,
      }),
    ).toEqual({
      type: "arrow",
      relationType: "link",
      label: "",
      color: "#c7ced6",
      size: 0.45,
      forceLabel: false,
      hidden: false,
    });

    sigma.renderer.refresh.mockClear();
    view.rerender(
      <KnowledgeGraphWebgl
        nodes={nodes}
        edges={edges}
        selectedNodeId="page-0"
        onSelectNode={vi.fn()}
        onFocusNode={vi.fn()}
      />,
    );

    expect(sigmaMocks.Sigma).toHaveBeenCalledTimes(1);
    expect(forceAtlasMocks.Worker).toHaveBeenCalledTimes(1);
    expect(sigma.renderer.refresh).toHaveBeenCalledTimes(1);
    expect(sigma.renderer.refresh).toHaveBeenCalledWith({
      partialGraph: { nodes: ["page-anchor", "page-0"] },
      schedule: true,
      skipIndexation: true,
    });
    expect(
      nodeReducer("page-0", {
        x: 0,
        y: 0,
        label: "Other",
        type: "circle",
        size: 10,
        color: "#228be6",
      }),
    ).toEqual({
      x: 0,
      y: 0,
      label: "Other",
      type: "circle",
      size: 10,
      color: "#228be6",
      highlighted: true,
    });
  });

  it("does not refresh a selected node after filtering removes it", () => {
    const nodes = buildLargeGraphNodes();
    const filteredNodes = nodes.filter((node) => node.id !== "page-anchor");
    const edges: KnowledgeGraphEdge[] = [];
    const view = render(
      <KnowledgeGraphWebgl
        nodes={nodes}
        edges={edges}
        selectedNodeId="page-anchor"
        onSelectNode={vi.fn()}
        onFocusNode={vi.fn()}
      />,
    );

    view.rerender(
      <KnowledgeGraphWebgl
        nodes={filteredNodes}
        edges={edges}
        selectedNodeId="page-anchor"
        onSelectNode={vi.fn()}
        onFocusNode={vi.fn()}
      />,
    );
    const renderer = sigmaMocks.instances.at(-1)?.renderer;
    expect(renderer).toBeDefined();
    renderer?.refresh.mockClear();

    view.rerender(
      <KnowledgeGraphWebgl
        nodes={filteredNodes}
        edges={edges}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
        onFocusNode={vi.fn()}
      />,
    );

    expect(renderer?.refresh).not.toHaveBeenCalled();
  });

  it("animates nearby nodes after layout settles but hides halos when zoomed out", () => {
    const edges: KnowledgeGraphEdge[] = [
      {
        id: "contains-1",
        from: "page-anchor",
        to: "section-high",
        type: "contains",
        label: "contains",
        weight: 1,
        reasons: ["section-membership"],
      },
    ];
    const view = render(
      <KnowledgeGraphWebgl
        nodes={buildLargeGraphNodes()}
        edges={edges}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
        onFocusNode={vi.fn()}
      />,
    );
    const canvas = view.container.querySelector("canvas");

    expect(canvas).not.toBeNull();
    expect(canvas?.style.pointerEvents).toBe("none");
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
    expect(canvas?.width).toBe(1_600);
    expect(canvas?.height).toBe(1_000);
    expect(overlayContext.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);

    runAnimationFrameBatch(16);
    runAnimationFrameBatch(80);
    expect(overlayContext.arc).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(4_120);
    });
    runAnimationFrameBatch(4_200);
    expect(overlayContext.clearRect).toHaveBeenCalled();
    expect(overlayContext.arc).toHaveBeenCalled();
    expect(overlayContext.stroke).toHaveBeenCalled();
    expect(overlayContext.setLineDash).toHaveBeenCalledWith([4, 4]);

    overlayContext.arc.mockClear();
    act(() => {
      sigmaMocks.instances[0].cameraListeners.get("updated")?.({
        x: 0.5,
        y: 0.5,
        angle: 0,
        ratio: 0.5,
      });
    });
    runAnimationFrameBatch(4_300);
    expect(overlayContext.arc).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(120);
    });
    runAnimationFrameBatch(4_500);
    expect(overlayContext.arc).not.toHaveBeenCalled();

    act(() => {
      sigmaMocks.instances[0].cameraListeners.get("updated")?.({
        x: 0.5,
        y: 0.5,
        angle: 0,
        ratio: 0.12,
      });
      vi.advanceTimersByTime(120);
    });
    runAnimationFrameBatch(4_700);
    expect(overlayContext.arc).toHaveBeenCalled();

    view.unmount();
    expect(resizeObserverDisconnects[0]).toHaveBeenCalledTimes(1);
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it("stops motion frames while the document is hidden", () => {
    render(
      <KnowledgeGraphWebgl
        nodes={buildLargeGraphNodes()}
        edges={[]}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
        onFocusNode={vi.fn()}
      />,
    );
    runNextAnimationFrame();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    vi.mocked(cancelAnimationFrame).mockClear();

    act(() => document.dispatchEvent(new Event("visibilitychange")));

    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(animationFrames.size).toBe(0);
    vi.mocked(sigmaMocks.instances[0].renderer.graphToViewport).mockClear();

    act(() => vi.advanceTimersByTime(4_120));

    expect(
      sigmaMocks.instances[0].renderer.graphToViewport,
    ).not.toHaveBeenCalled();

    hidden.mockReturnValue(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    expect(animationFrames.size).toBe(1);
    act(() => vi.advanceTimersByTime(120));
    expect(sigmaMocks.instances[0].renderer.graphToViewport).toHaveBeenCalled();
  });
});

function buildLargeGraphNodes(): KnowledgeGraphNode[] {
  return [
    {
      id: "section-high",
      title: "Highest overall",
      spaceId: "space-1",
      kind: "section",
      degree: 100,
    },
    {
      id: "page-anchor",
      title: "Highest page",
      spaceId: "space-1",
      kind: "page",
      degree: 20,
    },
    ...Array.from({ length: 499 }, (_, index) => ({
      id: "page-" + index,
      title: "Page " + index,
      spaceId: "space-1",
      kind: "page" as const,
      degree: index % 10,
    })),
  ];
}

function runNextAnimationFrame() {
  const nextFrame = animationFrames.entries().next().value as
    | [number, FrameRequestCallback]
    | undefined;
  expect(nextFrame).toBeDefined();
  animationFrames.delete(nextFrame?.[0] ?? -1);
  act(() => {
    nextFrame?.[1](16);
  });
}

function runAnimationFrameBatch(time: number) {
  const frames = [...animationFrames.entries()];
  for (const [id] of frames) animationFrames.delete(id);
  act(() => {
    for (const [, callback] of frames) {
      callback(time);
    }
  });
}
