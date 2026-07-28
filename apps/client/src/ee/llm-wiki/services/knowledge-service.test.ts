import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileKnowledgeSpaces,
  getKnowledgeGraph,
  getKnowledgeDiagnostics,
  queryKnowledge,
  retryKnowledgePages,
  runKnowledgeAdminAction,
  updateKnowledgeSpace,
  forceRebuildKnowledgeSpace,
} from "./knowledge-service";

describe("queryKnowledge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes missing citations to an empty list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ answer: "No matching knowledge." }),
      }),
    );

    await expect(
      queryKnowledge({
        query: "Chaterm Flutter 的项目架构",
        spaceIds: ["space-1"],
      }),
    ).resolves.toEqual({
      answer: "No matching knowledge.",
      citations: [],
      snippets: [],
      warnings: [],
      retrievalReasons: [],
      budget: undefined,
      completenessNotice: undefined,
    });
  });

  it("unwraps API envelope for query results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            answer: "Chaterm Flutter uses feature modules.",
            citations: [
              { sourcePageId: "page-1", title: "项目架构", url: "/p/page-1" },
            ],
          },
          success: true,
          status: 200,
        }),
      }),
    );

    await expect(
      queryKnowledge({
        query: "Chaterm Flutter 的项目架构",
        spaceIds: ["space-1"],
      }),
    ).resolves.toEqual({
      answer: "Chaterm Flutter uses feature modules.",
      citations: [
        { sourcePageId: "page-1", title: "项目架构", url: "/p/page-1" },
      ],
      snippets: [],
      warnings: [],
      retrievalReasons: [],
      budget: undefined,
      completenessNotice: undefined,
    });
  });

  it("queues selected spaces for compilation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ queuedSpaceCount: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      compileKnowledgeSpaces({ spaceIds: ["space-1", "space-2"] }),
    ).resolves.toEqual({ queuedSpaceCount: 2, jobIds: [] });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/llm-wiki/admin/compile-spaces",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ spaceIds: ["space-1", "space-2"] }),
      }),
    );
  });

  it("unwraps API envelope for compilation results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { queuedSpaceCount: 1 },
          success: true,
          status: 200,
        }),
      }),
    );

    await expect(
      compileKnowledgeSpaces({ spaceIds: ["space-1"] }),
    ).resolves.toEqual({ queuedSpaceCount: 1, jobIds: [] });
  });

  it("updates one space through the incremental knowledge endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { queuedSpaceCount: 1, jobIds: ["job-1"] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateKnowledgeSpace({
        spaceId: "space-1",
        confirmationSpaceName: "AIM",
      }),
    ).resolves.toEqual({ queuedSpaceCount: 1, jobIds: ["job-1"] });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/llm-wiki/admin/spaces/space-1/update-knowledge",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ confirmationSpaceName: "AIM" }),
      }),
    );
  });

  it("force rebuilds one space without sending a mode field", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { queuedSpaceCount: 1 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      forceRebuildKnowledgeSpace({
        spaceId: "space/with slash",
        confirmationSpaceName: " AIM ",
      }),
    ).resolves.toEqual({ queuedSpaceCount: 1, jobIds: [] });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/llm-wiki/admin/spaces/space%2Fwith%20slash/force-rebuild-knowledge",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ confirmationSpaceName: " AIM " }),
      }),
    );
  });

  it("queues an admin space action", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          action: "reindex_access",
          queuedSpaceCount: 1,
          jobIds: ["knowledge-reindex-access:workspace-1:space-1:run-1"],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runKnowledgeAdminAction({
        action: "reindex_access",
        spaceIds: ["space-1"],
      }),
    ).resolves.toEqual({
      action: "reindex_access",
      queuedSpaceCount: 1,
      jobIds: ["knowledge-reindex-access:workspace-1:space-1:run-1"],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/llm-wiki/admin/space-action",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          action: "reindex_access",
          spaceIds: ["space-1"],
        }),
      }),
    );
  });

  it("loads admin diagnostics and normalizes missing arrays", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          pages: [
            {
              pageId: "page-1",
              title: "Chaterm",
              spaceName: "AIM",
              knowledgeChunkCount: 3,
              compileStatus: "skipped",
              compileStage: "completed",
              compileAttemptCount: 1,
              compileErrorCode: "empty_source",
              compileErrorMessage: "Knowledge source is empty.",
              lastSucceededAt: "2026-07-20T10:00:00.000Z",
              servingLastSuccessfulVersion: false,
            },
          ],
          compileStatuses: [
            {
              spaceId: "space-1",
              status: "superseded",
              jobId: "job-1",
              lastRunId: "run-1",
              durationMs: null,
              sourceCount: 0,
              succeededPageCount: 56,
              failedPageCount: 5,
              skippedPageCount: 0,
              importedArtifactCount: 0,
              quarantinedArtifactCount: 0,
              failureReason: "Compile job failed: Error",
              updatedAt: 1000,
            },
          ],
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
              contentMarkdown: "Private launch plan",
              inputSourceRefs: [{ sourcePageId: "source-secret-1" }],
            },
          ],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getKnowledgeDiagnostics({
      spaceIds: ["space-1"],
      limit: 20,
    });

    expect(result).toEqual({
      pages: [
        {
          pageId: "page-1",
          slugId: "",
          title: "Chaterm",
          spaceId: "",
          spaceName: "AIM",
          spaceSlug: "",
          updatedAt: "",
          deletedAt: null,
          textLength: 0,
          knowledgeSourceCount: 0,
          staleSourceCount: 0,
          oldestStaleSourceAt: null,
          knowledgePageSourceCount: 0,
          knowledgeChunkCount: 3,
          missingEmbeddingChunkCount: 0,
          lastCompiledAt: null,
          lastAccessPolicyIndexedAt: null,
          staleAccessPolicyCount: 0,
          compileStatus: "skipped",
          compileStage: "completed",
          compileAttemptCount: 1,
          compileErrorCode: "empty_source",
          compileErrorMessage: "Knowledge source is empty.",
          lastSucceededAt: "2026-07-20T10:00:00.000Z",
          servingLastSuccessfulVersion: false,
        },
      ],
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
      canViewGlobalQueues: false,
      queueSnapshots: {
        text: {
          waiting: 3,
          active: 2,
          delayed: 1,
          prioritized: 4,
          waitingChildren: 5,
          paused: 6,
          failed: 7,
          completed: 8,
          sampledAt: null,
        },
        image: {
          waiting: 0,
          active: 0,
          delayed: 0,
          prioritized: 0,
          waitingChildren: 0,
          paused: 0,
          failed: 0,
          completed: 0,
          sampledAt: null,
        },
      },
      compileRuns: [
        {
          runId: "run-1",
          spaceId: "space-1",
          spaceName: "",
          status: "superseded",
          updatedAt: "1970-01-01T00:00:01.000Z",
          progress: {
            text: {
              expected: 61,
              succeeded: 56,
              failed: 5,
              skipped: 0,
              pending: 0,
              waiting: 0,
              lastAttemptError: "Compile job failed: Error",
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
      compileStatuses: [
        {
          spaceId: "space-1",
          status: "superseded",
          jobId: "job-1",
          lastRunId: "run-1",
          durationMs: null,
          sourceCount: 0,
          succeededPageCount: 56,
          failedPageCount: 5,
          skippedPageCount: 0,
          importedArtifactCount: 0,
          quarantinedArtifactCount: 0,
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
      quality: undefined,
    });
    expect(JSON.stringify(result)).not.toContain("Private launch plan");
    expect(JSON.stringify(result)).not.toContain("source-secret-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/llm-wiki/admin/diagnostics",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ spaceIds: ["space-1"], limit: 20 }),
      }),
    );
  });

  it("normalizes independent queue snapshots and durable run progress", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            canViewGlobalQueues: true,
            queueSnapshots: {
              ai: {
                waiting: 1,
                active: 2,
                delayed: 3,
                paused: 4,
                failed: 5,
                completed: 6,
                sampledAt: "2026-07-28T06:00:00.000Z",
              },
              text: {
                waiting: 7,
                active: 8,
                sampledAt: "2026-07-28T06:00:01.000Z",
              },
              image: {
                waiting: 9,
                active: 10,
                sampledAt: "2026-07-28T06:00:02.000Z",
              },
            },
            compileRuns: [
              {
                runId: "run-1",
                spaceId: "space-1",
                spaceName: "AIM",
                status: "running",
                mode: "update",
                phase: "image",
                progress: {
                  text: {
                    expected: 10,
                    succeeded: 7,
                    failed: 1,
                    skipped: 1,
                    pending: 1,
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
                    expected: 5,
                    succeeded: 2,
                    failed: 0,
                    skipped: 1,
                    pending: 2,
                    waiting: 0,
                  },
                },
              },
            ],
          },
        }),
      }),
    );

    const result = await getKnowledgeDiagnostics({ spaceIds: ["space-1"] });

    expect(result.canViewGlobalQueues).toBe(true);
    expect(result.queueSnapshots).not.toHaveProperty("ai");
    expect(result.queueSnapshots?.text).toEqual({
      waiting: 7,
      active: 8,
      delayed: 0,
      prioritized: 0,
      waitingChildren: 0,
      paused: 0,
      failed: 0,
      completed: 0,
      sampledAt: "2026-07-28T06:00:01.000Z",
    });
    expect(result.compileRuns?.[0]?.progress.image).toEqual({
      expected: 5,
      succeeded: 2,
      failed: 1,
      skipped: 0,
      pending: 2,
      waiting: 1,
      lastAttemptError: "Vision timed out",
    });
  });

  it("maps durable database run states to stable client states", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            compileRuns: [
              { runId: "run-compiling", status: "compiling" },
              { runId: "run-pending", status: "aggregate_pending" },
              { runId: "run-aggregating", status: "aggregating" },
              { runId: "run-completed", status: "completed" },
            ],
          },
        }),
      }),
    );

    const result = await getKnowledgeDiagnostics({ spaceIds: ["space-1"] });

    expect(result.compileRuns?.map((run) => run.status)).toEqual([
      "running",
      "running",
      "running",
      "succeeded",
    ]);
  });

  it("retries explicit source pages", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          queuedPageCount: 2,
          jobIds: ["page-job-1", "page-job-2"],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      retryKnowledgePages({ pageIds: ["page-1", "page-2"] }),
    ).resolves.toEqual({
      queuedPageCount: 2,
      jobIds: ["page-job-1", "page-job-2"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/llm-wiki/admin/retry-pages",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ pageIds: ["page-1", "page-2"] }),
      }),
    );
  });

  it("loads a space knowledge graph and normalizes nodes and edges", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          nodes: [
            {
              id: "kp-1",
              title: "Kafka",
              spaceId: "space-1",
              sourcePageId: "page-1",
              degree: 2,
            },
            {
              id: "section:section-1",
              title: "Retrieval",
              spaceId: "space-1",
              sourcePageId: "page-1",
              kind: "section",
              parentPageId: "kp-1",
              headingPath: ["Architecture", "Retrieval"],
              excerpt: "ACL before LIMIT.",
              degree: 1,
            },
          ],
          edges: [
            {
              id: "edge-1",
              from: "kp-1",
              to: "kp-2",
              type: "semantic",
              label: "depends on",
            },
            {
              id: "contains:section-1",
              from: "kp-1",
              to: "section:section-1",
              type: "contains",
              label: "包含章节",
            },
          ],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getKnowledgeGraph({ spaceId: "space-1", limit: 200 }),
    ).resolves.toEqual({
      nodes: [
        {
          id: "kp-1",
          title: "Kafka",
          spaceId: "space-1",
          sourcePageId: "page-1",
          kind: "page",
          parentPageId: undefined,
          headingPath: undefined,
          excerpt: undefined,
          degree: 2,
          artifactKind: undefined,
          communityId: undefined,
        },
        {
          id: "section:section-1",
          title: "Retrieval",
          spaceId: "space-1",
          sourcePageId: "page-1",
          kind: "section",
          parentPageId: "kp-1",
          headingPath: ["Architecture", "Retrieval"],
          excerpt: "ACL before LIMIT.",
          degree: 1,
          artifactKind: undefined,
          communityId: undefined,
        },
      ],
      edges: [
        {
          id: "edge-1",
          from: "kp-1",
          to: "kp-2",
          type: "semantic",
          label: "depends on",
          weight: 0,
          reasons: [],
        },
        {
          id: "contains:section-1",
          from: "kp-1",
          to: "section:section-1",
          type: "contains",
          label: "包含章节",
          weight: 0,
          reasons: [],
        },
      ],
      insights: {
        isolatedNodeIds: [],
        bridgeNodeIds: [],
        communityCount: 0,
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/llm-wiki/graph?spaceId=space-1&limit=200",
      expect.objectContaining({
        method: "GET",
        credentials: "include",
      }),
    );
  });
});
