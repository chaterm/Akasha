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
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelKnowledgeCompilationRun,
  forceRebuildKnowledgeSpace,
  getKnowledgeDelayedPageDiagnostics,
  getKnowledgeQualityDiagnostics,
  getKnowledgeQuarantineDiagnostics,
  getKnowledgeRetrievalDiagnostics,
  getKnowledgeRunDiagnostics,
  getKnowledgeRunDiagnosticsSummary,
  getKnowledgeRunPageDiagnostics,
  getKnowledgeWorkerDiagnostics,
  immediatelyCompileDelayedPage,
  removeDelayedPageFromQueue,
  retryKnowledgePages,
  runKnowledgeAdminAction,
  updateKnowledgeSpace,
} from "../services/knowledge-service";
import KnowledgeAdminPage, {
  knowledgeDiagnosticsRefetchInterval,
} from "./knowledge-admin";
import type { KnowledgeRunDiagnostic } from "../types/knowledge.types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/config", () => ({ getAppName: () => "Akasha" }));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));
vi.mock("@/features/space/queries/space-query", () => ({
  useGetSpacesQuery: () => ({
    data: {
      items: [
        { id: "space-1", name: "AIM", slug: "aim" },
        { id: "space-2", name: "General", slug: "general" },
      ],
    },
    isLoading: false,
  }),
}));
vi.mock("@/hooks/use-user-role", () => ({
  default: () => ({ isAdmin: true, isOwner: true, isMember: false }),
}));
vi.mock("../services/knowledge-service", () => ({
  cancelKnowledgeCompilationRun: vi.fn(),
  getKnowledgeDelayedPageDiagnostics: vi.fn(),
  getKnowledgeRunDiagnosticsSummary: vi.fn(),
  getKnowledgeRunDiagnostics: vi.fn(),
  getKnowledgeRunPageDiagnostics: vi.fn(),
  getKnowledgeWorkerDiagnostics: vi.fn(),
  getKnowledgeQualityDiagnostics: vi.fn(),
  getKnowledgeQuarantineDiagnostics: vi.fn(),
  getKnowledgeRetrievalDiagnostics: vi.fn(),
  immediatelyCompileDelayedPage: vi.fn(),
  removeDelayedPageFromQueue: vi.fn(),
  retryKnowledgePages: vi.fn(),
  runKnowledgeAdminAction: vi.fn(),
  updateKnowledgeSpace: vi.fn(),
  forceRebuildKnowledgeSpace: vi.fn(),
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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getKnowledgeRunDiagnosticsSummary).mockResolvedValue(summary());
    vi.mocked(getKnowledgeRunDiagnostics).mockResolvedValue({
      items: [run()],
      total: 100,
      page: 1,
      limit: 50,
    });
    vi.mocked(getKnowledgeRunPageDiagnostics).mockResolvedValue({
      run: { runId: "run-1", spaceId: "space-1", spaceName: "AIM" },
      items: [failedPage()],
      total: 1,
      page: 1,
      limit: 50,
    });
    vi.mocked(getKnowledgeWorkerDiagnostics).mockResolvedValue({
      sampledAt: "2026-07-31T12:00:00.000Z",
      databaseMaxPool: 25,
      schedulingAuthority: "postgresql",
      space: worker(10, 30),
      image: worker(5, 15),
    });
    vi.mocked(getKnowledgeDelayedPageDiagnostics).mockResolvedValue({
      summary: {
        sampledAt: "2026-08-05T10:00:00.000Z",
        waitingPageCount: 1,
        duePageCount: 0,
        affectedSpaceCount: 1,
        oldestFirstChangedAt: "2026-08-05T09:30:00.000Z",
        nextEligibleAt: "2026-08-05T10:30:00.000Z",
      },
      items: [
        {
          scheduleId: "11111111-1111-4111-8111-111111111111",
          sourcePageId: "page-1",
          spaceId: "space-1",
          spaceName: "AIM",
          title: "BeeGFS deployment",
          slugId: "beegfs-deployment",
          trigger: "page_updated",
          changeCount: 2,
          status: "waiting",
          firstChangedAt: "2026-08-05T09:30:00.000Z",
          lastChangedAt: "2026-08-05T09:30:00.000Z",
          eligibleAt: "2026-08-05T10:30:00.000Z",
          remainingWaitMs: 30 * 60 * 1000,
          createdAt: "2026-08-05T09:30:00.000Z",
          updatedAt: "2026-08-05T09:30:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      limit: 50,
    });
    vi.mocked(immediatelyCompileDelayedPage).mockResolvedValue({
      accepted: true,
      scheduleId: "11111111-1111-4111-8111-111111111111",
      sourcePageId: "page-1",
      spaceId: "space-1",
    });
    vi.mocked(removeDelayedPageFromQueue).mockResolvedValue({
      removed: true,
      scheduleId: "11111111-1111-4111-8111-111111111111",
      sourcePageId: "page-1",
      spaceId: "space-1",
    });
    vi.mocked(getKnowledgeQualityDiagnostics).mockResolvedValue({
      summary: {
        pageCount: 5000,
        compiledPageCount: 4998,
        stalePageCount: 1,
        missingSourcePageCount: 0,
        missingChunkPageCount: 1,
        missingEmbeddingPageCount: 1,
        healthScore: 99,
      },
      spaces: [
        {
          spaceId: "space-1",
          spaceName: "AIM",
          pageCount: 5000,
          compiledPageCount: 4998,
          stalePageCount: 1,
          missingChunkPageCount: 1,
          missingEmbeddingPageCount: 1,
          oldestStaleSourceAgeHours: 2,
          healthScore: 99,
        },
      ],
      topIssues: [
        {
          code: "missing_chunks",
          severity: "high",
          message: "Some pages have no compiled chunks.",
          affectedPageCount: 1,
        },
      ],
    });
    vi.mocked(getKnowledgeQuarantineDiagnostics).mockResolvedValue({
      items: [
        {
          id: "quarantine-1",
          workspaceId: "workspace-1",
          spaceId: "space-1",
          artifactId: "artifact-1",
          artifactKind: "source_summary",
          compilerRunId: "run-1",
          compileTaskId: null,
          reasonCodes: ["invalid_source_range"],
          createdAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });
    vi.mocked(getKnowledgeRetrievalDiagnostics).mockResolvedValue({
      sampleCount: 100,
      zeroHitRate: 0.03,
      embeddingFallbackRate: 0.01,
      accessPolicyFallbackRate: 0,
      averageAuthorizedCandidateCount: 8,
      averageFilteredCandidateCount: 1,
    });
    vi.mocked(retryKnowledgePages).mockResolvedValue({
      queuedPageCount: 1,
      jobIds: ["run-2"],
    });
    vi.mocked(runKnowledgeAdminAction).mockResolvedValue({
      action: "rebuild_embeddings",
      queuedSpaceCount: 1,
      jobIds: ["maintenance-1"],
    });
    vi.mocked(updateKnowledgeSpace).mockResolvedValue({
      runId: "run-2",
      mode: "incremental",
      knowledgeGeneration: 5,
    });
    vi.mocked(forceRebuildKnowledgeSpace).mockResolvedValue({
      runId: "run-3",
      mode: "force_rebuild",
      knowledgeGeneration: 6,
    });
    vi.mocked(cancelKnowledgeCompilationRun).mockResolvedValue({
      disposition: "cancelled",
      runId: "run-1",
      spaceId: "space-1",
      status: "cancelled",
      phase: "complete",
      previousStatus: "queued",
      previousPhase: "text",
      removedJobCount: 1,
      fencedActiveJobCount: 0,
      cleanupErrorCount: 0,
    });
  });

  it("shows bounded Run diagnostics and loads RunPages only on demand", async () => {
    renderPage();

    expect(await screen.findByText("Space compilation runs")).toBeTruthy();
    expect(screen.getAllByText("All spaces").length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(getKnowledgeRunDiagnosticsSummary).toHaveBeenCalledWith({}),
    );
    expect(getKnowledgeRunDiagnostics).toHaveBeenCalledWith({
      statuses: ["queued", "compiling", "aggregate_pending", "aggregating"],
      page: 1,
      limit: 50,
    });
    expect(await screen.findByText("Waiting initialization")).toBeTruthy();
    expect(await screen.findByText("Space dispatch pending")).toBeTruthy();
    expect(await screen.findByText("text continuation")).toBeTruthy();
    expect(screen.getByText("50/100")).toBeTruthy();
    expect(screen.getAllByText("15/20")).toHaveLength(2);
    expect(
      screen.getByText("Succeeded 45 · Failed 2 · Skipped 3"),
    ).toBeTruthy();
    expect(getKnowledgeRunPageDiagnostics).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "View pages" }));

    expect(await screen.findByText("Large page")).toBeTruthy();
    expect(screen.getByText("budget timeout")).toBeTruthy();
    expect(getKnowledgeRunPageDiagnostics).toHaveBeenCalledWith({
      runId: "run-1",
      page: 1,
      limit: 50,
    });
  });

  it("loads quality, retrieval, and paginated quarantine only after opening the health tab", async () => {
    renderPage();
    await screen.findByText("Space compilation runs");

    expect(getKnowledgeQualityDiagnostics).not.toHaveBeenCalled();
    expect(getKnowledgeQuarantineDiagnostics).not.toHaveBeenCalled();
    expect(getKnowledgeRetrievalDiagnostics).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Health and quarantine" }));

    expect(await screen.findByText("Knowledge health")).toBeTruthy();
    expect(await screen.findByText("artifact-1")).toBeTruthy();
    expect(getKnowledgeQualityDiagnostics).toHaveBeenCalledWith({});
    expect(getKnowledgeQuarantineDiagnostics).toHaveBeenCalledWith({
      page: 1,
      limit: 20,
    });
    expect(getKnowledgeRetrievalDiagnostics).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(getKnowledgeRunDiagnosticsSummary).toHaveBeenCalledTimes(2),
    );
    expect(getKnowledgeQualityDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("requires the exact page name before immediately compiling a delayed page", async () => {
    renderPage();
    await screen.findByText("Space compilation runs");

    fireEvent.click(screen.getByRole("tab", { name: "Delayed queue" }));
    expect(await screen.findByText("BeeGFS deployment")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Immediate compile" }));

    const dialog = await screen.findByRole("dialog");
    const confirmButton = within(dialog).getByRole("button", {
      name: "Immediate compile",
    });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(
      within(dialog).getByLabelText("Type the page name to confirm"),
      { target: { value: "BeeGFS deployment" } },
    );
    fireEvent.click(confirmButton);

    await waitFor(() =>
      expect(immediatelyCompileDelayedPage).toHaveBeenCalledWith(
        {
          scheduleId: "11111111-1111-4111-8111-111111111111",
          confirmationPageName: "BeeGFS deployment",
        },
        expect.anything(),
      ),
    );
  });

  it("removes a delayed page from the queue without a confirmation dialog", async () => {
    renderPage();
    await screen.findByText("Space compilation runs");

    fireEvent.click(screen.getByRole("tab", { name: "Delayed queue" }));
    expect(await screen.findByText("BeeGFS deployment")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove from queue" }));

    await waitFor(() =>
      expect(removeDelayedPageFromQueue).toHaveBeenCalledWith(
        {
          scheduleId: "11111111-1111-4111-8111-111111111111",
          confirmationPageName: "BeeGFS deployment",
        },
        expect.anything(),
      ),
    );
    expect(
      screen.queryByRole("dialog", { name: "Remove from queue" }),
    ).toBeNull();
  });

  it("passes search, status, phase, and pagination through the bounded Run query", async () => {
    vi.mocked(getKnowledgeRunDiagnostics).mockImplementation(async (input) => ({
      items: [
        run({
          runId: input.page === 2 ? "run-page-2" : "run-page-1",
          spaceName: input.page === 2 ? "General" : "AIM",
        }),
      ],
      total: 100,
      page: input.page,
      limit: input.limit,
    }));
    renderPage();

    await screen.findByText("run-page-1");
    fireEvent.change(screen.getByLabelText("Search Space or Run"), {
      target: { value: "run-page" },
    });
    selectOption("queued");
    selectOption("text");

    await waitFor(() =>
      expect(getKnowledgeRunDiagnostics).toHaveBeenCalledWith({
        statuses: ["queued"],
        phases: ["text"],
        search: "run-page",
        page: 1,
        limit: 50,
      }),
    );
    await screen.findByText("run-page-1");

    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(await screen.findByText("run-page-2")).toBeTruthy();
    expect(screen.queryByText("run-page-1")).toBeNull();
    expect(getKnowledgeRunDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, limit: 50 }),
    );
  });

  it("switches between all readable spaces and an explicit space scope", async () => {
    renderPage();
    await screen.findByText("Space compilation runs");

    selectOption("space-1");
    await waitFor(() =>
      expect(getKnowledgeRunDiagnostics).toHaveBeenCalledWith({
        spaceIds: ["space-1"],
        statuses: ["queued", "compiling", "aggregate_pending", "aggregating"],
        page: 1,
        limit: 50,
      }),
    );

    const callsBeforeReturningToAll = vi.mocked(getKnowledgeRunDiagnostics).mock
      .calls.length;
    selectOption("__all_spaces__");
    await waitFor(() =>
      expect(
        vi.mocked(getKnowledgeRunDiagnostics).mock.calls.length,
      ).toBeGreaterThan(callsBeforeReturningToAll),
    );
    expect(getKnowledgeRunDiagnostics).toHaveBeenLastCalledWith({
      statuses: ["queued", "compiling", "aggregate_pending", "aggregating"],
      page: 1,
      limit: 50,
    });
  });

  it("stops requesting RunPage details after the detail modal closes", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "View pages" }));
    await screen.findByText("Large page");
    expect(getKnowledgeRunPageDiagnostics).toHaveBeenCalledTimes(1);

    const detailDialog = screen.getByRole("dialog", { name: "Run pages" });
    fireEvent.click(within(detailDialog).getAllByRole("button")[0]);
    await waitFor(() => expect(screen.queryByText("Large page")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(getKnowledgeRunDiagnosticsSummary).toHaveBeenCalledTimes(2),
    );
    expect(getKnowledgeRunPageDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("shows unknown estimates when BullMQ worker discovery is unsupported", async () => {
    vi.mocked(getKnowledgeWorkerDiagnostics).mockResolvedValue({
      sampledAt: "2026-07-31T12:00:00.000Z",
      databaseMaxPool: 25,
      schedulingAuthority: "postgresql",
      space: {
        ...worker(10, 30),
        workerCount: null,
        capacity: null,
        source: "unsupported" as const,
      },
      image: {
        ...worker(5, 15),
        workerCount: null,
        capacity: null,
        source: "unsupported" as const,
      },
    });

    renderPage();

    expect(await screen.findAllByText("Unknown")).toHaveLength(2);
  });

  it("retries only explicitly selected failed RunPages", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "View pages" }));
    await screen.findByText("Large page");

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Retry selected" }));

    await waitFor(() =>
      expect(retryKnowledgePages).toHaveBeenCalledWith(
        { pageIds: ["page-1"] },
        expect.anything(),
      ),
    );
  });

  it("allows retry when text succeeded but the page merge failed", async () => {
    vi.mocked(getKnowledgeRunPageDiagnostics).mockResolvedValue({
      run: { runId: "run-1", spaceId: "space-1", spaceName: "AIM" },
      items: [
        {
          ...failedPage(),
          status: "succeeded",
          mergeStatus: "failed",
          errorCode: "embedding_provider_error",
          errorCategory: "provider",
          errorSummary: "Knowledge embedding provider request failed.",
        },
      ],
      total: 1,
      page: 1,
      limit: 50,
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "View pages" }));
    await screen.findByText("Large page");

    const retry = screen.getByRole("checkbox");
    expect((retry as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(retry);
    fireEvent.click(screen.getByRole("button", { name: "Retry selected" }));

    await waitFor(() =>
      expect(retryKnowledgePages).toHaveBeenCalledWith(
        { pageIds: ["page-1"] },
        expect.anything(),
      ),
    );
  });

  it("requires the exact Space name before requesting an update", async () => {
    renderPage();
    await screen.findByText("Space compilation runs");
    expect(
      screen.queryByRole("button", { name: "Update knowledge" }),
    ).toBeNull();
    selectOption("space-1");
    await screen.findByText("Space operations");
    fireEvent.click(screen.getByRole("button", { name: "Update knowledge" }));

    const input = await screen.findByLabelText(
      "Type the space name to confirm",
    );
    const confirm = screen.getByRole("button", { name: "Confirm" });
    fireEvent.change(input, { target: { value: " AIM" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "AIM" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(updateKnowledgeSpace).toHaveBeenCalledWith({
        spaceId: "space-1",
        confirmationSpaceName: "AIM",
      }),
    );
  });

  it("cancels one exact active Run only after explicit Space confirmation", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel run" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Cancel compilation run",
    });
    expect(
      within(dialog).getByText(
        "Remaining compilation work will stop. Knowledge already published by completed pages is retained.",
      ),
    ).toBeTruthy();
    const confirmName = within(dialog).getByLabelText(
      "Type the space name to confirm",
    );
    const reason = within(dialog).getByLabelText("Reason (optional)");
    const confirm = within(dialog).getByRole("button", { name: "Cancel run" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(confirmName, { target: { value: "AIM" } });
    fireEvent.change(reason, { target: { value: "  Test completed.  " } });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(cancelKnowledgeCompilationRun).toHaveBeenCalledWith(
        { runId: "run-1", reason: "Test completed." },
        expect.anything(),
      ),
    );
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
    expect(knowledgeDiagnosticsRefetchInterval()).toBe(5_000);
    if (original) Object.defineProperty(document, "visibilityState", original);
  });
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <HelmetProvider>
        <MantineProvider>
          <BrowserRouter>
            <KnowledgeAdminPage />
          </BrowserRouter>
        </MantineProvider>
      </HelmetProvider>
    </QueryClientProvider>,
  );
}

function selectOption(value: string): void {
  const option = document.querySelector<HTMLElement>(
    `[role="option"][value="${value}"]`,
  );
  if (!option) throw new Error(`Select option not found: ${value}`);
  fireEvent.click(option);
}

function summary() {
  return {
    sampledAt: "2026-07-31T12:00:00.000Z",
    activeRunCount: 43,
    activeSpaceSlotRunCount: 27,
    waitingInitializationCount: 18,
    queuedRunCount: 70,
    recentCompletedCount: 36,
    recentFailedCount: 2,
    recentYieldCount: 28,
    longestCurrentSlotWaitMs: 480_000,
    statusCounts: { queued: 70 },
    phaseCounts: { text: 25 },
    imageStatusCounts: { processing: 12 },
    dispatch: { spaceUnacknowledged: 1, imageUnacknowledged: 2 },
    recovery: {
      expiredExecutionLeases: 0,
      spaceRecovering: 0,
      spaceRecoveryExhausted: 0,
      imageRecovering: 0,
      imageRecoveryExhausted: 0,
    },
    failureCategories: {
      budgetTimeout: 3,
      provider: 1,
      publication: 0,
      infrastructure: 0,
      other: 0,
    },
    queues: { space: queue(70, 27), image: queue(5, 12) },
    workerEvents: {
      windowMs: 3_600_000,
      stalled: 0,
      lockRenewalFailed: 0,
      source: "process_local" as const,
    },
  };
}

function run(
  overrides: Partial<KnowledgeRunDiagnostic> = {},
): KnowledgeRunDiagnostic {
  return {
    runId: "run-1",
    spaceId: "space-1",
    spaceName: "AIM",
    status: "queued" as const,
    mode: "incremental" as const,
    phase: "text" as const,
    knowledgeGeneration: 4,
    queueState: "text_continuation" as const,
    spaceJobSequence: 10,
    lastYieldAt: "2026-07-31T11:59:00.000Z",
    lastYieldReason: "page_limit",
    workerId: null,
    errorCode: null,
    initializedAt: "2026-07-31T11:00:00.000Z",
    queuedAt: "2026-07-31T11:00:00.000Z",
    startedAt: "2026-07-31T11:01:00.000Z",
    finishedAt: null,
    createdAt: "2026-07-31T11:00:00.000Z",
    updatedAt: "2026-07-31T12:00:00.000Z",
    runDurationMs: 3_600_000,
    currentSliceWaitMs: 120_000,
    progress: {
      text: { expected: 100, succeeded: 45, failed: 2, skipped: 3 },
      images: { expected: 20, succeeded: 10, failed: 2, skipped: 3 },
      merge: { expected: 20, succeeded: 12, failed: 1, skipped: 2 },
    },
    ...overrides,
  };
}

function failedPage() {
  return {
    runPageId: "run-page-1",
    sourcePageId: "page-1",
    title: "Large page",
    slugId: "large-page",
    status: "failed",
    imageStatus: "partial",
    mergeStatus: "pending",
    expectedImageCount: 3,
    succeededImageCount: 1,
    failedImageCount: 2,
    skippedImageCount: 0,
    errorCode: "page_timeout",
    errorCategory: "budget_timeout" as const,
    errorSummary: "Knowledge compilation exceeded its page budget.",
    queuedAt: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-07-31T12:00:00.000Z",
    imageFailures: { retryableExhausted: 1, permanent: 1 },
  };
}

function queue(waiting: number, active: number) {
  return {
    waiting,
    active,
    delayed: 0,
    prioritized: 0,
    waitingChildren: 0,
    paused: 0,
    failed: 0,
    completed: 0,
    sampledAt: "2026-07-31T12:00:00.000Z",
  };
}

function worker(concurrency: number, capacity: number) {
  return {
    workerCount: 3,
    capacity,
    exact: false as const,
    source: "bullmq_client_list" as const,
    concurrency,
    lockDuration: 120_000,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  };
}
