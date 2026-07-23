import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverReview,
  loadReviewSnapshot,
  negotiateReview,
} from "./review-service";

describe("review-service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when no saved snapshot exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: null, success: true, status: 200 }),
      }),
    );

    await expect(
      loadReviewSnapshot({ spaceId: "space-1" }),
    ).resolves.toBeNull();
  });

  it("unwraps and normalizes a saved review snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            version: "2",
            items: [],
            docs: [
              { id: "kp-1", title: "Launch plan", sourcePageId: "page-1" },
            ],
            resolvedReviews: [],
            jobs: [],
            applications: [],
            discoveredAt: "2026-06-22T03:00:00.000Z",
            updatedAt: "2026-06-22T03:10:00.000Z",
          },
          success: true,
          status: 200,
        }),
      }),
    );

    await expect(loadReviewSnapshot({ spaceId: "space-1" })).resolves.toEqual({
      version: "2",
      items: [],
      docs: [{ id: "kp-1", title: "Launch plan", sourcePageId: "page-1" }],
      resolvedReviews: [],
      jobs: [],
      applications: [],
      discoveredAt: "2026-06-22T03:00:00.000Z",
      updatedAt: "2026-06-22T03:10:00.000Z",
    });
  });

  it("normalizes discover responses as snapshots", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            version: "2",
            items: [],
            docs: [],
            resolvedReviews: [],
            jobs: [],
            applications: [],
            discoveredAt: "2026-06-22T03:00:00.000Z",
            updatedAt: "2026-06-22T03:00:00.000Z",
          },
          success: true,
          status: 200,
        }),
      }),
    );

    await expect(
      discoverReview({ spaceId: "space-1", limit: 20 }),
    ).resolves.toEqual({
      version: "2",
      items: [],
      docs: [],
      resolvedReviews: [],
      jobs: [],
      applications: [],
      discoveredAt: "2026-06-22T03:00:00.000Z",
      updatedAt: "2026-06-22T03:00:00.000Z",
    });
  });

  it("polls discover jobs until a snapshot is ready", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            job: {
              jobId: "review-discover__workspace-1__space-1",
              kind: "discover",
              itemId: null,
              status: "pending",
              error: null,
              createdAt: "2026-06-25T00:00:00.000Z",
              startedAt: null,
              finishedAt: null,
            },
            result: null,
          },
          success: true,
          status: 200,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            job: {
              jobId: "review-discover__workspace-1__space-1",
              kind: "discover",
              itemId: null,
              status: "done",
              error: null,
              createdAt: "2026-06-25T00:00:00.000Z",
              startedAt: "2026-06-25T00:00:01.000Z",
              finishedAt: "2026-06-25T00:00:02.000Z",
            },
            result: {
              version: "2",
              items: [],
              docs: [],
              resolvedReviews: [],
              jobs: [],
              applications: [],
              discoveredAt: "2026-06-25T00:00:00.000Z",
              updatedAt: "2026-06-25T00:00:02.000Z",
            },
          },
          success: true,
          status: 200,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const onJob = vi.fn();

    await expect(
      discoverReview({ spaceId: "space-1", onJob }),
    ).resolves.toEqual(
      expect.objectContaining({
        items: [],
        jobs: [],
        updatedAt: "2026-06-25T00:00:02.000Z",
      }),
    );
    expect(onJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "review-discover__workspace-1__space-1",
        kind: "discover",
        status: "pending",
      }),
    );
    expect(onJob.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[1],
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/llm-wiki/review/jobs/review-discover__workspace-1__space-1?spaceId=space-1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("still returns resolved review payloads from negotiate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            item: {
              id: "rev-1",
              type: "missing-page",
              title: "Add page",
              detail: "Missing",
              recommendation: "Create it",
              relatedDocIds: ["kp-1"],
              searchQueries: ["query"],
              outline: ["Goal"],
            },
            feedback: "采纳",
            skipped: false,
            deepSearched: false,
            searchResults: [],
            draft: {
              title: "New page",
              body: "# New page",
              applyOperation: "create-page",
              targetDocId: null,
              notes: "",
            },
          },
          success: true,
          status: 200,
        }),
      }),
    );

    await expect(
      negotiateReview({
        spaceId: "space-1",
        item: {
          id: "rev-1",
          type: "missing-page",
          title: "Add page",
          detail: "Missing",
          recommendation: "Create it",
          relatedDocIds: ["kp-1"],
          searchQueries: ["query"],
          outline: ["Goal"],
        },
        feedback: "采纳",
      }),
    ).resolves.toMatchObject({
      feedback: "采纳",
      skipped: false,
      draft: { applyOperation: "create-page" },
    });
  });

  it("polls negotiate jobs while notifying callers about the queued job", async () => {
    const item = {
      id: "rev-1",
      type: "missing-page" as const,
      title: "Add page",
      detail: "Missing",
      recommendation: "Create it",
      relatedDocIds: ["kp-1"],
      searchQueries: ["query"],
      outline: ["Goal"],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            job: {
              jobId: "review-negotiate__workspace-1__space-1__rev-1",
              kind: "negotiate",
              itemId: "rev-1",
              status: "pending",
              error: null,
              createdAt: "2026-06-25T00:00:00.000Z",
              startedAt: null,
              finishedAt: null,
            },
            result: null,
          },
          success: true,
          status: 200,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            job: {
              jobId: "review-negotiate__workspace-1__space-1__rev-1",
              kind: "negotiate",
              itemId: "rev-1",
              status: "done",
              error: null,
              createdAt: "2026-06-25T00:00:00.000Z",
              startedAt: "2026-06-25T00:00:01.000Z",
              finishedAt: "2026-06-25T00:00:02.000Z",
            },
            result: {
              item,
              feedback: "采纳",
              skipped: false,
              deepSearched: false,
              searchResults: [],
              draft: {
                title: "New page",
                body: "New page body",
                applyOperation: ["create-page"],
                targetDocId: null,
                notes: "",
              },
              applied: null,
              turns: [],
            },
          },
          success: true,
          status: 200,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const onJob = vi.fn();

    await expect(
      negotiateReview({
        spaceId: "space-1",
        item,
        feedback: "采纳",
        onJob,
      }),
    ).resolves.toMatchObject({
      feedback: "采纳",
      skipped: false,
      draft: { applyOperation: ["create-page"] },
    });
    expect(onJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "review-negotiate__workspace-1__space-1__rev-1",
        kind: "negotiate",
        itemId: "rev-1",
        status: "pending",
      }),
    );
    expect(onJob.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[1],
    );
  });

  it("keeps full negotiation history while exposing the latest draft", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            version: "2",
            items: [],
            docs: [],
            jobs: [],
            applications: [],
            resolvedReviews: [
              {
                item: {
                  id: "rev-1",
                  type: "missing-page",
                  title: "Add page",
                  detail: "Missing",
                  recommendation: "Create it",
                  relatedDocIds: ["kp-1"],
                  searchQueries: ["query"],
                  outline: ["Goal"],
                },
                feedback: "old",
                skipped: false,
                deepSearched: false,
                searchResults: [],
                draft: {
                  title: "Old page",
                  body: "Old",
                  applyOperation: ["create-page"],
                  targetDocId: null,
                  notes: "",
                },
                applied: null,
                turns: [
                  {
                    feedback: "old",
                    deepSearched: false,
                    searchResults: [],
                    draft: {
                      title: "Old page",
                      body: "Old",
                      applyOperation: ["create-page"],
                      targetDocId: null,
                      notes: "",
                    },
                  },
                  {
                    feedback: "latest",
                    deepSearched: false,
                    searchResults: [],
                    draft: {
                      title: "Latest page",
                      body: "Latest",
                      applyOperation: ["create-page"],
                      targetDocId: null,
                      notes: "",
                    },
                  },
                ],
              },
            ],
            discoveredAt: "2026-06-22T03:00:00.000Z",
            updatedAt: "2026-06-22T03:10:00.000Z",
          },
          success: true,
          status: 200,
        }),
      }),
    );

    await expect(loadReviewSnapshot({ spaceId: "space-1" })).resolves.toEqual(
      expect.objectContaining({
        resolvedReviews: [
          expect.objectContaining({
            feedback: "latest",
            draft: expect.objectContaining({ title: "Latest page" }),
            turns: [
              expect.objectContaining({
                feedback: "old",
                draft: expect.objectContaining({ title: "Old page" }),
              }),
              expect.objectContaining({
                feedback: "latest",
                draft: expect.objectContaining({ title: "Latest page" }),
              }),
            ],
          }),
        ],
      }),
    );
  });
});
