import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { BrowserRouter } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import KnowledgeAdminPage, {
  knowledgeDiagnosticsRefetchInterval,
} from "./knowledge-admin";
import {
  forceRebuildKnowledgeSpace,
  getKnowledgeDiagnostics,
  retryKnowledgePages,
  runKnowledgeAdminAction,
  updateKnowledgeSpace,
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
    queueCounts: {
      waiting: 3,
      active: 2,
      delayed: 1,
      prioritized: 4,
      waitingChildren: 5,
      paused: 6,
      failed: 7,
      completed: 8,
    },
    canViewGlobalQueues: true,
    queueSnapshots: {
      text: {
        waiting: 9,
        active: 1,
        delayed: 0,
        prioritized: 0,
        waitingChildren: 0,
        paused: 0,
        failed: 2,
        completed: 10,
        sampledAt: "2026-07-28T06:00:01.000Z",
      },
      image: {
        waiting: 4,
        active: 2,
        delayed: 1,
        prioritized: 0,
        waitingChildren: 0,
        paused: 0,
        failed: 1,
        completed: 3,
        sampledAt: "2026-07-28T06:00:02.000Z",
      },
    },
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
    compileRuns: [
      {
        runId: "run-1",
        spaceId: "space-1",
        spaceName: "AIM",
        status: "running",
        mode: "update",
        phase: "image",
        createdAt: "2026-07-28T05:00:00.000Z",
        updatedAt: "2026-07-28T06:00:00.000Z",
        progress: {
          text: {
            expected: 4,
            succeeded: 2,
            failed: 1,
            skipped: 1,
            pending: 0,
            waiting: 0,
          },
          image: {
            expected: 5,
            succeeded: 2,
            failed: 1,
            skipped: 0,
            pending: 2,
            waiting: 1,
            lastAttemptError: "Vision timed out",
          },
          merge: {
            expected: 4,
            succeeded: 2,
            failed: 0,
            skipped: 1,
            pending: 1,
            waiting: 1,
          },
        },
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
  updateKnowledgeSpace: vi.fn().mockResolvedValue({
    queuedSpaceCount: 1,
    jobIds: ["knowledge-update-space:space-1"],
  }),
  forceRebuildKnowledgeSpace: vi.fn().mockResolvedValue({
    queuedSpaceCount: 1,
    jobIds: ["knowledge-force-rebuild-space:space-1"],
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

  it("shows per-space failures, queue snapshots, and run progress", async () => {
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
    expect(screen.getByText("Current queue tasks")).toBeTruthy();
    expect(screen.getByText("Recent records")).toBeTruthy();
    expect(screen.getByText("Text compilation queue")).toBeTruthy();
    expect(screen.getByText("Image recognition queue")).toBeTruthy();
    expect(screen.getByText("Waiting: 9")).toBeTruthy();
    expect(screen.getByText("Waiting: 4")).toBeTruthy();
    expect(screen.queryByText("AI queue")).toBeNull();
    expect(screen.getByText("Compilation run history")).toBeTruthy();
    expect(screen.getByText("Text progress")).toBeTruthy();
    expect(screen.getByText("Image progress")).toBeTruthy();
    expect(screen.getByText("Merge progress")).toBeTruthy();
    expect(
      screen.getByText("Last attempt error: Vision timed out"),
    ).toBeTruthy();

    expect(screen.queryByRole("button", { name: "Retry compile" })).toBeNull();
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

  it("hides global queue details while retaining authorized durable progress", async () => {
    mockDiagnosticsWithAimSpace({ canViewGlobalQueues: false });

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

    expect(await screen.findByText("Compilation run history")).toBeTruthy();
    expect(screen.getByText("Text progress")).toBeTruthy();
    expect(screen.queryByText("Current queue tasks")).toBeNull();
    expect(screen.queryByText("AI queue")).toBeNull();
    expect(screen.queryByText("Text compilation queue")).toBeNull();
    expect(screen.queryByText("Image recognition queue")).toBeNull();
  });

  it("stops diagnostics polling while the page is hidden", () => {
    const original = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });

    expect(knowledgeDiagnosticsRefetchInterval()).toBe(false);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    expect(knowledgeDiagnosticsRefetchInterval()).toBe(5000);

    if (original) {
      Object.defineProperty(document, "visibilityState", original);
    }
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
      queueCounts: EMPTY_TEST_QUEUE_COUNTS,
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
      screen.getByRole("columnheader", { name: "Missing embeddings" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("columnheader", { name: "Embedding" }),
    ).toBeNull();
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

  it("requires the exact space name before updating one space", async () => {
    mockDiagnosticsWithAimSpace();
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

    await screen.findAllByText("AIM");
    expect(
      await screen.findAllByRole("button", { name: "Update knowledge" }),
    ).toHaveLength(1);
    const spaceRow = screen.getByRole("row", { name: /AIM.*Update knowledge/ });
    const spaceCells = within(spaceRow).getAllByRole("cell");
    expect(
      within(spaceCells[spaceCells.length - 1]).getByRole("button", {
        name: "Update knowledge",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update knowledge" }));

    expect(
      await screen.findByText(
        "Only changed pages are compiled. Unchanged pages reuse existing knowledge, and existing knowledge is not cleared.",
      ),
    ).toBeTruthy();
    const confirmationInput = screen.getByLabelText(
      "Type the space name to confirm",
    );
    const submit = screen.getByRole("button", {
      name: "Confirm knowledge update",
    });
    fireEvent.change(confirmationInput, { target: { value: " AIM" } });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(confirmationInput, { target: { value: "AIM" } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(updateKnowledgeSpace).toHaveBeenCalledWith({
        spaceId: "space-1",
        confirmationSpaceName: "AIM",
      });
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Update knowledge" }),
      ).toBeNull();
    });
  });

  it("keeps the destructive force rebuild dialog open when confirmation is rejected", async () => {
    mockDiagnosticsWithAimSpace();
    vi.mocked(forceRebuildKnowledgeSpace).mockRejectedValueOnce(
      new Error("Space name changed. Enter the current name."),
    );

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

    await screen.findAllByText("AIM");
    fireEvent.click(
      await screen.findByRole("button", { name: "Dangerous actions" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Force rebuild knowledge" }),
    );

    expect(
      await screen.findByText(
        "This permanently clears all compiled knowledge, image recognition cache, vectors, and relationships for this space.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Original pages and attachments are preserved. Knowledge is unavailable while rebuilding.",
      ),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Type the space name to confirm"), {
      target: { value: "AIM" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm force rebuild" }),
    );

    expect(
      await screen.findByText("Space name changed. Enter the current name."),
    ).toBeTruthy();
    expect(
      screen.getByRole("dialog", { name: "Force rebuild knowledge" }),
    ).toBeTruthy();
    expect(forceRebuildKnowledgeSpace).toHaveBeenCalledWith({
      spaceId: "space-1",
      confirmationSpaceName: "AIM",
    });
  });
});

const EMPTY_TEST_QUEUE_COUNTS = {
  waiting: 0,
  active: 0,
  delayed: 0,
  prioritized: 0,
  waitingChildren: 0,
  paused: 0,
  failed: 0,
  completed: 0,
};

function mockDiagnosticsWithAimSpace(options?: {
  canViewGlobalQueues?: boolean;
}) {
  vi.mocked(getKnowledgeDiagnostics).mockResolvedValue({
    pages: [],
    jobs: [],
    queueCounts: EMPTY_TEST_QUEUE_COUNTS,
    compileStatuses: [],
    quarantines: [],
    canViewGlobalQueues: options?.canViewGlobalQueues ?? false,
    queueSnapshots: {
      text: { ...EMPTY_TEST_QUEUE_COUNTS, sampledAt: null },
      image: { ...EMPTY_TEST_QUEUE_COUNTS, sampledAt: null },
    },
    compileRuns: [
      {
        runId: "run-1",
        spaceId: "space-1",
        spaceName: "AIM",
        status: "running",
        progress: {
          text: {
            expected: 1,
            succeeded: 0,
            failed: 0,
            skipped: 0,
            pending: 1,
            waiting: 1,
          },
          image: {
            expected: 0,
            succeeded: 0,
            failed: 0,
            skipped: 0,
            pending: 0,
            waiting: 0,
          },
          merge: {
            expected: 0,
            succeeded: 0,
            failed: 0,
            skipped: 0,
            pending: 0,
            waiting: 0,
          },
        },
      },
    ],
    quality: {
      summary: {
        pageCount: 1,
        compiledPageCount: 1,
        stalePageCount: 0,
        missingSourcePageCount: 0,
        missingChunkPageCount: 0,
        missingEmbeddingPageCount: 0,
        healthScore: 100,
      },
      spaces: [
        {
          spaceId: "space-1",
          spaceName: "AIM",
          pageCount: 1,
          compiledPageCount: 1,
          stalePageCount: 0,
          missingChunkPageCount: 0,
          missingEmbeddingPageCount: 0,
          oldestStaleSourceAgeHours: null,
          healthScore: 100,
        },
      ],
      topIssues: [],
    },
  });
}
