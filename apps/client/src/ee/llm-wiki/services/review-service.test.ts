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
      applications: [],
      discoveredAt: "2026-06-22T03:00:00.000Z",
      updatedAt: "2026-06-22T03:00:00.000Z",
    });
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
