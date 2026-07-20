import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { HelmetProvider } from "react-helmet-async";
import { BrowserRouter, MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import KnowledgeGraphPage from "./knowledge-graph";
import { getKnowledgeGraph } from "../services/knowledge-service";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query";

const currentDir = dirname(fileURLToPath(import.meta.url));
const graphCss = readFileSync(
  resolve(currentDir, "../styles/knowledge-graph.module.css"),
  "utf8",
);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/lib/config", () => ({
  getAppName: () => "Akasha",
}));

vi.mock("@/features/space/queries/space-query", () => ({
  useGetSpacesQuery: () => ({
    data: {
      items: [
        {
          id: "space-1",
          name: "AIM",
          slug: "aim",
        },
      ],
    },
    isLoading: false,
  }),
  useGetSpaceBySlugQuery: vi.fn(() => ({
    data: undefined,
    isLoading: false,
  })),
}));

vi.mock("../services/knowledge-service", () => ({
  getKnowledgeGraph: vi.fn().mockResolvedValue({
    nodes: [
      {
        id: "kp-1",
        title: "Kafka",
        spaceId: "space-1",
        sourcePageId: "page-1",
        kind: "page",
        degree: 1,
      },
      {
        id: "kp-2",
        title: "Chaterm",
        spaceId: "space-1",
        kind: "page",
        degree: 1,
      },
      {
        id: "section:section-1",
        title: "Retrieval",
        spaceId: "space-1",
        sourcePageId: "page-1",
        kind: "section",
        parentPageId: "kp-1",
        headingPath: ["Architecture", "Retrieval"],
        excerpt: "ACL filtering runs before candidate limits.",
        degree: 1,
      },
    ],
    edges: [
      {
        id: "link-1",
        from: "kp-1",
        to: "kp-2",
        type: "link",
        label: "references",
        weight: 3,
        reasons: ["direct-link"],
      },
      {
        id: "edge-1",
        from: "kp-1",
        to: "kp-2",
        type: "semantic",
        label: "depends on",
        weight: 2,
        reasons: ["semantic-edge"],
      },
      {
        id: "contains:section-1",
        from: "kp-1",
        to: "section:section-1",
        type: "contains",
        label: "包含章节",
        weight: 1,
        reasons: ["section-membership"],
      },
    ],
    insights: {
      isolatedNodeIds: [],
      bridgeNodeIds: ["kp-1", "kp-2"],
      communityCount: 1,
    },
  }),
}));

describe("KnowledgeGraphPage", () => {
  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    Object.defineProperty(window, "ResizeObserver", {
      writable: true,
      value: class ResizeObserver {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    });
  });

  it("renders the selected space graph and links single-source nodes to pages", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <HelmetProvider>
          <MantineProvider>
            <BrowserRouter>
              <KnowledgeGraphPage />
            </BrowserRouter>
          </MantineProvider>
        </HelmetProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Kafka")).toBeTruthy();
    expect(screen.getByText("Chaterm")).toBeTruthy();
    expect(screen.getByText("references")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Kafka" }).getAttribute("href"),
    ).toBe("/p/page-1");
    await waitFor(() => {
      expect(getKnowledgeGraph).toHaveBeenCalledWith({
        spaceId: "space-1",
        limit: 3000,
      });
    });
  });

  it("uses the current space when rendered under a space graph route", async () => {
    vi.mocked(useGetSpaceBySlugQuery).mockReturnValue({
      data: {
        id: "space-current",
        name: "AIM",
        slug: "aim",
      },
      isLoading: false,
    } as ReturnType<typeof useGetSpaceBySlugQuery>);
    vi.mocked(getKnowledgeGraph).mockClear();

    render(
      <QueryClientProvider client={new QueryClient()}>
        <HelmetProvider>
          <MantineProvider>
            <MemoryRouter initialEntries={["/s/aim/graph"]}>
              <Routes>
                <Route
                  path="/s/:spaceSlug/graph"
                  element={<KnowledgeGraphPage />}
                />
              </Routes>
            </MemoryRouter>
          </MantineProvider>
        </HelmetProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(getKnowledgeGraph).toHaveBeenCalledWith({
        spaceId: "space-current",
        limit: 3000,
      });
    });
  });

  it("supports zoom controls for the graph canvas", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <HelmetProvider>
          <MantineProvider>
            <BrowserRouter>
              <KnowledgeGraphPage />
            </BrowserRouter>
          </MantineProvider>
        </HelmetProvider>
      </QueryClientProvider>,
    );

    await screen.findByText("Kafka");
    const viewport = screen.getByTestId("knowledge-graph-viewport");
    const initialTransform = viewport.getAttribute("transform");

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(viewport.getAttribute("transform")).not.toBe(initialTransform);
    expect(screen.getByRole("button", { name: "Fit graph" })).toBeTruthy();
  });

  it("keeps the graph page within the AppShell viewport", () => {
    expect(graphCss).toMatch(
      /\.pageContainer\s*{[^}]*height:\s*calc\([\s\S]*?100dvh[\s\S]*?--app-shell-header-offset[\s\S]*?--app-shell-padding[\s\S]*?\);[^}]*}/s,
    );
    expect(graphCss).toMatch(
      /\.pageContainer\s*{[^}]*padding-block:\s*var\(--mantine-spacing-md\);[^}]*}/s,
    );
    expect(graphCss).toMatch(
      /\.pageStack\s*{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*}/s,
    );
    expect(graphCss).toMatch(
      /\.graphPanel\s*{[^}]*flex:\s*1 1 0;[^}]*min-height:\s*0;[^}]*}/s,
    );
    expect(graphCss).toMatch(
      /\.graphSvg\s*{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*}/s,
    );
  });

  it("renders graph filters, legend, and visible-only insight counts", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <HelmetProvider>
          <MantineProvider>
            <BrowserRouter>
              <KnowledgeGraphPage />
            </BrowserRouter>
          </MantineProvider>
        </HelmetProvider>
      </QueryClientProvider>,
    );

    await screen.findByText("Kafka");

    expect(screen.getByLabelText("Search")).toBeTruthy();
    expect(screen.getByLabelText("Links")).toBeTruthy();
    expect(screen.getByLabelText("Semantic")).toBeTruthy();
    expect(screen.getByLabelText("Isolated pages")).toBeTruthy();
    expect((screen.getByLabelText("Links") as HTMLInputElement).checked).toBe(
      true,
    );
    expect(
      (screen.getByLabelText("Semantic") as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Isolated pages") as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByText("Pages: 2")).toBeTruthy();
    expect(screen.getByText("Sections: 0")).toBeTruthy();
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByText("Wiki page")).toBeTruthy();
    expect(screen.getByText("depends on")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "Kafka" },
    });

    expect(screen.getByText("Kafka")).toBeTruthy();
  });

  it("focuses a page neighborhood and reveals its structural sections", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <HelmetProvider>
          <MantineProvider>
            <BrowserRouter>
              <KnowledgeGraphPage />
            </BrowserRouter>
          </MantineProvider>
        </HelmetProvider>
      </QueryClientProvider>,
    );

    await screen.findByText("Kafka");
    expect(screen.queryByText("Retrieval")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Graph node: Kafka" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus neighborhood" }));

    expect(await screen.findByText("Retrieval")).toBeTruthy();
    expect(screen.getByText("Focused neighborhood")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Graph node: Retrieval" }),
    );
    expect(
      screen.getByText("ACL filtering runs before candidate limits."),
    ).toBeTruthy();
  });

  it("shows edge labels only when a related node is hovered", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <HelmetProvider>
          <MantineProvider>
            <BrowserRouter>
              <KnowledgeGraphPage />
            </BrowserRouter>
          </MantineProvider>
        </HelmetProvider>
      </QueryClientProvider>,
    );

    await screen.findByText("Kafka");
    const edgeLabel = screen.getByText("references");

    expect(edgeLabel.getAttribute("data-visible")).toBe("false");

    fireEvent.mouseEnter(screen.getByText("Kafka"));

    expect(edgeLabel.getAttribute("data-visible")).toBe("true");
  });
});
