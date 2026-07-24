import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { BrowserRouter } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import KnowledgeQueryPage from "./knowledge-query";
import { queryKnowledge } from "../services/knowledge-service";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/lib/config", () => ({
  getAppName: () => "Akasha",
}));

vi.mock("@mantine/notifications", () => ({
  notifications: {
    show: vi.fn(),
  },
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
        {
          id: "space-2",
          name: "General",
          slug: "general",
        },
      ],
    },
    isLoading: false,
  }),
}));

vi.mock("../services/knowledge-service", () => ({
  compileKnowledgeSpaces: vi.fn().mockResolvedValue({
    queuedSpaceCount: 1,
    jobIds: [],
  }),
  queryKnowledge: vi.fn().mockResolvedValue({
    answer: "Chaterm 的软件著作权生效时间是 2026 年 06 月 05 日。",
    citations: [
      {
        sourcePageId: "page-used",
        title: "Chaterm 企业版登记信息",
        url: "/p/page-used",
      },
    ],
    snippets: [
      {
        id: "chunk-debug",
        title: "Debug snippet should not be visible",
        text: "检索候选片段不应直接展示给终端用户。",
        retrievalReasons: ["lexical"],
        sourceWindows: [],
      },
    ],
    warnings: [],
    retrievalReasons: ["lexical"],
    completenessNotice: undefined,
  }),
}));

describe("KnowledgeQueryPage", () => {
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

  it("keeps knowledge updates in Diagnostics instead of the query page", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <HelmetProvider>
          <MantineProvider>
            <BrowserRouter>
              <KnowledgeQueryPage />
            </BrowserRouter>
          </MantineProvider>
        </HelmetProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByRole("link", { name: "Diagnostics" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Update knowledge" }),
    ).toBeNull();
  });

  it("shows the answer and citations without exposing retrieved snippets", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <HelmetProvider>
          <MantineProvider>
            <BrowserRouter>
              <KnowledgeQueryPage />
            </BrowserRouter>
          </MantineProvider>
        </HelmetProvider>
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText("Question"), {
      target: { value: "chaterm 的软著生效时间是" },
    });

    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText(/2026 年 06 月 05 日/)).toBeTruthy();
    expect(screen.getByText("Chaterm 企业版登记信息")).toBeTruthy();
    expect(screen.queryByText("Snippets")).toBeNull();
    expect(
      screen.queryByText("Debug snippet should not be visible"),
    ).toBeNull();
    expect(vi.mocked(queryKnowledge).mock.calls[0]?.[0]).toEqual({
      query: "chaterm 的软著生效时间是",
      spaceIds: ["space-1"],
    });

    fireEvent.click(
      document
        .querySelector(".mantine-Pill-label")!
        .parentElement!.querySelector("button")!,
    );
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
  });
});
