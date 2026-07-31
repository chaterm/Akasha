import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { BrowserRouter } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forceRebuildKnowledgeSpace,
  getKnowledgeRunDiagnostics,
  getKnowledgeRunDiagnosticsSummary,
  getKnowledgeRunPageDiagnostics,
  getKnowledgeWorkerDiagnostics,
  retryKnowledgePages,
  runKnowledgeAdminAction,
  updateKnowledgeSpace,
} from "../services/knowledge-service";
import KnowledgeAdminPage, {
  knowledgeDiagnosticsRefetchInterval,
} from "./knowledge-admin";

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
  getKnowledgeRunDiagnosticsSummary: vi.fn(),
  getKnowledgeRunDiagnostics: vi.fn(),
  getKnowledgeRunPageDiagnostics: vi.fn(),
  getKnowledgeWorkerDiagnostics: vi.fn(),
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
  });

  it("shows bounded Run diagnostics and loads RunPages only on demand", async () => {
    renderPage();

    expect(await screen.findByText("Space compilation runs")).toBeTruthy();
    expect(await screen.findByText("Waiting initialization")).toBeTruthy();
    expect(await screen.findByText("text continuation")).toBeTruthy();
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

  it("requires the exact Space name before requesting an update", async () => {
    renderPage();
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

function run() {
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
      text: { expected: 100, succeeded: 45, failed: 0, skipped: 0 },
      images: { expected: 20, succeeded: 0 },
      merge: { expected: 20, succeeded: 0 },
    },
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
