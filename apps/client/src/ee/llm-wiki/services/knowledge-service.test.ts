import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileKnowledgeSpaces,
  getKnowledgeGraph,
  getKnowledgeDiagnostics,
  queryKnowledge,
  runKnowledgeAdminAction,
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
            },
          ],
          compileStatuses: [
            {
              spaceId: "space-1",
              status: "failed",
              jobId: "job-1",
              lastRunId: "run-1",
              durationMs: null,
              sourceCount: 0,
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
        },
      ],
      jobs: [],
      compileStatuses: [
        {
          spaceId: "space-1",
          status: "failed",
          jobId: "job-1",
          lastRunId: "run-1",
          durationMs: null,
          sourceCount: 0,
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
