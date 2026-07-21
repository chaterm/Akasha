import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { BrowserRouter } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import KnowledgeAdminPage from "./knowledge-admin";
import {
  getKnowledgeDiagnostics,
  retryKnowledgePages,
  runKnowledgeAdminAction,
} from "../services/knowledge-service";

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
    jobIds: ["knowledge-compile-space:workspace-1:space-1:run-1"],
  }),
  getKnowledgeDiagnostics: vi.fn().mockResolvedValue({
    pages: [],
    jobs: [],
    compileStatuses: [
      {
        spaceId: "space-1",
        status: "failed",
        jobId: "job-1",
        lastRunId: "run-1",
        durationMs: null,
        sourceCount: 4,
        importedArtifactCount: 1,
        quarantinedArtifactCount: 2,
        failureReason: "Compile job failed: Error",
        updatedAt: 1000,
      },
    ],
    retrieval: {
      sampleCount: 2,
      zeroHitRate: 0.5,
      embeddingFallbackRate: 0.5,
      accessPolicyFallbackRate: 0.25,
      averageAuthorizedCandidateCount: 1.5,
      averageFilteredCandidateCount: 2,
    },
    quarantines: [
      {
        id: "quarantine-1",
        workspaceId: "workspace-1",
        spaceId: "space-1",
        artifactId: "artifact-1",
        artifactKind: "source_summary",
        compilerRunId: "run-1",
        compileTaskId: "task-1",
        reasonCodes: ["artifact_source_range_invalid"],
        createdAt: "2026-06-18T08:00:00.000Z",
      },
    ],
    quality: {
      summary: {
        pageCount: 1,
        compiledPageCount: 0,
        stalePageCount: 1,
        missingSourcePageCount: 0,
        missingChunkPageCount: 1,
        missingEmbeddingPageCount: 0,
        healthScore: 30,
      },
      spaces: [
        {
          spaceId: "space-1",
          spaceName: "AIM",
          pageCount: 1,
          compiledPageCount: 0,
          stalePageCount: 1,
          missingChunkPageCount: 1,
          missingEmbeddingPageCount: 0,
          oldestStaleSourceAgeHours: 2,
          healthScore: 30,
        },
      ],
      topIssues: [],
    },
  }),
  runKnowledgeAdminAction: vi.fn().mockResolvedValue({
    action: "retry_compile",
    queuedSpaceCount: 1,
    jobIds: ["knowledge-compile-space:workspace-1:space-1:retry-1"],
  }),
  retryKnowledgePages: vi.fn().mockResolvedValue({
    queuedPageCount: 1,
    jobIds: ["knowledge-compile-pages:page-1:retry-1"],
  }),
}));

describe("KnowledgeAdminPage", () => {
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

  it("shows per-space compile failures and lets admins retry the space", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <HelmetProvider>
          <MantineProvider>
            <BrowserRouter>
              <KnowledgeAdminPage />
            </BrowserRouter>
          </MantineProvider>
        </HelmetProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Compile job failed: Error")).toBeTruthy();
    expect(screen.getByText("Zero-hit: 50%")).toBeTruthy();
    expect(screen.getByText("Embedding fallback: 50%")).toBeTruthy();
    expect(screen.getAllByText("failed").length).toBeGreaterThan(0);
    expect(screen.getByText("Quarantined: 2")).toBeTruthy();
    expect(screen.getByText("artifact_source_range_invalid")).toBeTruthy();
    expect(screen.getByText("artifact-1")).toBeTruthy();
    expect(screen.getByLabelText("Stale column help")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry compile" }));

    await waitFor(() => {
      expect(vi.mocked(runKnowledgeAdminAction).mock.calls[0]?.[0]).toEqual({
        action: "retry_compile",
        spaceIds: ["space-1"],
      });
    });
    expect(getKnowledgeDiagnostics).toHaveBeenCalledWith({
      spaceIds: ["space-1"],
      limit: 50,
    });

    fireEvent.click(
      document
        .querySelector(".mantine-Pill-label")!
        .parentElement!.querySelector("button")!,
    );
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
  });

  it("filters page attempts and retries one or selected failed pages", async () => {
    vi.mocked(getKnowledgeDiagnostics).mockResolvedValue({
      pages: [
        {
          pageId: "page-1",
          slugId: "failed-page",
          title: "Failed page",
          spaceId: "space-1",
          spaceName: "AIM",
          spaceSlug: "aim",
          updatedAt: "2026-07-20T11:00:00.000Z",
          deletedAt: null,
          textLength: 100,
          knowledgeSourceCount: 1,
          staleSourceCount: 0,
          oldestStaleSourceAt: null,
          knowledgePageSourceCount: 1,
          knowledgeChunkCount: 2,
          missingEmbeddingChunkCount: 0,
          lastCompiledAt: "2026-07-20T10:00:00.000Z",
          lastAccessPolicyIndexedAt: null,
          staleAccessPolicyCount: 0,
          compileStatus: "failed",
          compileStage: "generation",
          compileAttemptCount: 3,
          compileErrorCode: "invalid_output",
          compileErrorMessage: "Knowledge compiler returned invalid output.",
          lastSucceededAt: "2026-07-20T10:00:00.000Z",
          servingLastSuccessfulVersion: true,
        },
      ],
      jobs: [],
      compileStatuses: [],
      quarantines: [],
    });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <HelmetProvider>
          <MantineProvider>
            <BrowserRouter>
              <KnowledgeAdminPage />
            </BrowserRouter>
          </MantineProvider>
        </HelmetProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Last successful version")).toBeTruthy();
    expect(
      screen
        .getAllByLabelText("Compile status")
        .some((element) => element.tagName === "INPUT"),
    ).toBe(true);
    expect(
      screen
        .getAllByLabelText("Compile stage")
        .some((element) => element.tagName === "INPUT"),
    ).toBe(true);
    expect(
      screen.getByText("Knowledge compiler returned invalid output."),
    ).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Select Failed page"));
    fireEvent.click(screen.getByRole("button", { name: "Retry selected" }));
    await waitFor(() => {
      expect(retryKnowledgePages).toHaveBeenCalledWith(
        {
          pageIds: ["page-1"],
        },
        expect.anything(),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry Failed page" }));
    await waitFor(() => {
      expect(retryKnowledgePages).toHaveBeenLastCalledWith(
        {
          pageIds: ["page-1"],
        },
        expect.anything(),
      );
    });
  });
});
