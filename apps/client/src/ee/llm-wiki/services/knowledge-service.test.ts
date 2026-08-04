import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelKnowledgeCompilationRun,
  compileKnowledgeSpaces,
  forceRebuildKnowledgeSpace,
  getKnowledgeQualityDiagnostics,
  getKnowledgeQuarantineDiagnostics,
  getKnowledgeRetrievalDiagnostics,
  getKnowledgeRunDiagnostics,
  getKnowledgeRunDiagnosticsSummary,
  getKnowledgeRunPageDiagnostics,
  getKnowledgeWorkerDiagnostics,
  retryKnowledgePages,
  updateKnowledgeSpace,
} from "./knowledge-service";

describe("knowledge service", () => {
  afterEach(() => vi.restoreAllMocks());

  it("normalizes requestRuns dispositions from the multi-Space endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          requestedSpaceCount: 3,
          acceptedRunCount: 1,
          coalescedRunCount: 1,
          rerunRequestedCount: 1,
          runs: [
            { spaceId: "space-1", runId: "run-1", disposition: "created" },
            { spaceId: "space-2", runId: "run-2", disposition: "coalesced" },
            {
              spaceId: "space-3",
              runId: "run-3",
              disposition: "rerun_requested",
            },
          ],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      compileKnowledgeSpaces({ spaceIds: ["space-1", "space-2", "space-3"] }),
    ).resolves.toEqual({
      requestedSpaceCount: 3,
      acceptedRunCount: 1,
      coalescedRunCount: 1,
      rerunRequestedCount: 1,
      runs: [
        { spaceId: "space-1", runId: "run-1", disposition: "created" },
        { spaceId: "space-2", runId: "run-2", disposition: "coalesced" },
        {
          spaceId: "space-3",
          runId: "run-3",
          disposition: "rerun_requested",
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/llm-wiki/admin/compile-spaces",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("uses distinct confirmed incremental and force-rebuild endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          runId: "run-1",
          mode: "force_rebuild",
          knowledgeGeneration: 7,
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await updateKnowledgeSpace({
      spaceId: "space-1",
      confirmationSpaceName: "AIM",
    });
    await expect(
      forceRebuildKnowledgeSpace({
        spaceId: "space-1",
        confirmationSpaceName: "AIM",
      }),
    ).resolves.toEqual({
      runId: "run-1",
      mode: "force_rebuild",
      knowledgeGeneration: 7,
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/llm-wiki/admin/spaces/space-1/update-knowledge",
      "/api/llm-wiki/admin/spaces/space-1/force-rebuild-knowledge",
    ]);
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ confirmationSpaceName: "AIM" }),
      }),
    );
  });

  it("cancels one exact Run and normalizes the control-plane result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          disposition: "cancelled",
          runId: "run/1",
          spaceId: "space-1",
          status: "cancelled",
          phase: "complete",
          previousStatus: "compiling",
          previousPhase: "images",
          removedJobCount: 4,
          fencedActiveJobCount: 1,
          cleanupErrorCount: 0,
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cancelKnowledgeCompilationRun({
        runId: "run/1",
        reason: "  Capacity test completed.  ",
      }),
    ).resolves.toEqual({
      disposition: "cancelled",
      runId: "run/1",
      spaceId: "space-1",
      status: "cancelled",
      phase: "complete",
      previousStatus: "compiling",
      previousPhase: "images",
      removedJobCount: 4,
      fencedActiveJobCount: 1,
      cleanupErrorCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/llm-wiki/admin/compilation-runs/run%2F1/cancel",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ reason: "Capacity test completed." }),
      }),
    );
  });

  it("loads bounded summary and paginated Run diagnostics separately", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          activeRunCount: 43,
          activeSpaceSlotRunCount: 27,
          waitingInitializationCount: 18,
          queuedRunCount: 70,
          recentCompletedCount: 36,
          recentFailedCount: 2,
          recentYieldCount: 28,
          longestCurrentSlotWaitMs: 480000,
          statusCounts: { queued: 70 },
          phaseCounts: { text: 25 },
          imageStatusCounts: { processing: 12 },
          dispatch: { spaceUnacknowledged: 1, imageUnacknowledged: 2 },
          recovery: { expiredExecutionLeases: 3 },
          failureCategories: { budgetTimeout: 4, provider: 1 },
          workerEvents: { windowMs: 3600000, stalled: 2 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            {
              runId: "run-1",
              spaceId: "space-1",
              spaceName: "AIM",
              status: "compiling",
              mode: "incremental",
              phase: "text",
              queueState: "text_continuation",
              progress: {
                text: { expected: 100, succeeded: 45, failed: 2, skipped: 3 },
                images: { expected: 20, succeeded: 10, failed: 2, skipped: 3 },
                merge: { expected: 20, succeeded: 12, failed: 1, skipped: 2 },
              },
            },
          ],
          total: 100,
          page: 2,
          limit: 50,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await getKnowledgeRunDiagnosticsSummary({
      spaceIds: ["space-1"],
    });
    const runs = await getKnowledgeRunDiagnostics({
      spaceIds: ["space-1"],
      statuses: ["compiling"],
      page: 2,
      limit: 50,
    });

    expect(summary.activeRunCount).toBe(43);
    expect(summary.failureCategories.budgetTimeout).toBe(4);
    expect(summary.workerEvents.lockRenewalFailed).toBe(0);
    expect(runs).toMatchObject({
      total: 100,
      page: 2,
      items: [
        {
          runId: "run-1",
          status: "compiling",
          queueState: "text_continuation",
          progress: {
            text: { expected: 100, succeeded: 45, failed: 2, skipped: 3 },
            images: { expected: 20, succeeded: 10, failed: 2, skipped: 3 },
            merge: { expected: 20, succeeded: 12, failed: 1, skipped: 2 },
          },
        },
      ],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/llm-wiki/admin/diagnostics/summary",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/llm-wiki/admin/diagnostics/runs",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("loads RunPage detail and worker capacity only from their bounded endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          run: { runId: "run-1", spaceId: "space-1", spaceName: "AIM" },
          items: [
            {
              runPageId: "run-page-1",
              sourcePageId: "page-1",
              status: "failed",
              errorCategory: "budget_timeout",
              imageFailures: { retryableExhausted: 1, permanent: 2 },
            },
          ],
          total: 1,
          page: 1,
          limit: 50,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sampledAt: "2026-07-31T12:00:00.000Z",
          databaseMaxPool: 25,
          space: {
            workerCount: 3,
            capacity: 30,
            source: "bullmq_client_list",
            concurrency: 10,
          },
          image: {
            workerCount: 3,
            capacity: 15,
            source: "bullmq_client_list",
            concurrency: 5,
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const pages = await getKnowledgeRunPageDiagnostics({
      runId: "run/1",
      page: 1,
      limit: 50,
    });
    const workers = await getKnowledgeWorkerDiagnostics();

    expect(pages.items[0]).toMatchObject({
      sourcePageId: "page-1",
      errorCategory: "budget_timeout",
      imageFailures: { retryableExhausted: 1, permanent: 2 },
    });
    expect(workers).toMatchObject({
      schedulingAuthority: "postgresql",
      databaseMaxPool: 25,
      space: { capacity: 30, exact: false },
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/llm-wiki/admin/diagnostics/runs/run%2F1/pages?page=1&limit=50",
      "/api/llm-wiki/admin/diagnostics/workers",
    ]);
  });

  it("loads quality, quarantine, and retrieval from independent on-demand endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            summary: { pageCount: 5000, healthScore: 98 },
            spaces: [
              {
                spaceId: "space-1",
                spaceName: "AIM",
                pageCount: 5000,
                healthScore: 98,
              },
            ],
            topIssues: [
              {
                code: "missing_embeddings",
                severity: "medium",
                affectedPageCount: 2,
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            items: [
              {
                id: "quarantine-1",
                workspaceId: "workspace-1",
                spaceId: "space-1",
                reasonCodes: ["invalid_source_range"],
                createdAt: "2026-08-01T00:00:00.000Z",
              },
            ],
            total: 21,
            page: 2,
            limit: 20,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { sampleCount: 100, zeroHitRate: 0.03 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const quality = await getKnowledgeQualityDiagnostics({
      spaceIds: ["space-1"],
    });
    const quarantine = await getKnowledgeQuarantineDiagnostics({
      spaceIds: ["space-1"],
      page: 2,
      limit: 20,
    });
    const retrieval = await getKnowledgeRetrievalDiagnostics();

    expect(quality.summary).toMatchObject({ pageCount: 5000, healthScore: 98 });
    expect(quality.topIssues[0]).toMatchObject({
      code: "missing_embeddings",
      severity: "medium",
    });
    expect(quarantine).toMatchObject({ total: 21, page: 2 });
    expect(retrieval).toMatchObject({ sampleCount: 100, zeroHitRate: 0.03 });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/llm-wiki/admin/diagnostics/quality",
      "/api/llm-wiki/admin/diagnostics/quarantine",
      "/api/llm-wiki/admin/diagnostics/retrieval",
    ]);
  });

  it("retries only the explicit source page IDs supplied by the console", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { queuedPageCount: 2, jobIds: ["a", "b"] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      retryKnowledgePages({ pageIds: ["page-1", "page-2"] }),
    ).resolves.toEqual({ queuedPageCount: 2, jobIds: ["a", "b"] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/llm-wiki/admin/retry-pages",
      expect.objectContaining({
        body: JSON.stringify({ pageIds: ["page-1", "page-2"] }),
      }),
    );
  });
});
