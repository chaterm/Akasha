import type {
  KnowledgeAdminActionResult,
  KnowledgeAdminSpaceAction,
  KnowledgeContextBudget,
  KnowledgeCompileResult,
  KnowledgeCompileStatus,
  KnowledgeDiagnosticsResult,
  KnowledgeGraphNode,
  KnowledgeGraphResult,
  KnowledgeQualityIssue,
  KnowledgeQuarantinedArtifact,
  KnowledgeQueryResult,
  KnowledgeSourceWindow,
} from "../types/knowledge.types";

export async function queryKnowledge(params: {
  query: string;
  spaceIds: string[];
  chatContext?: string[];
}): Promise<KnowledgeQueryResult> {
  const response = await fetch("/api/llm-wiki/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message);
  }

  return normalizeKnowledgeQueryResult(unwrapApiData(await response.json()));
}

export async function compileKnowledgeSpaces(params: {
  spaceIds: string[];
}): Promise<KnowledgeCompileResult> {
  const response = await fetch("/api/llm-wiki/admin/compile-spaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message);
  }

  const body = unwrapApiData(await response.json());
  return normalizeCompileResult(body);
}

export async function runKnowledgeAdminAction(params: {
  action: KnowledgeAdminSpaceAction;
  spaceIds: string[];
}): Promise<KnowledgeAdminActionResult> {
  const response = await fetch("/api/llm-wiki/admin/space-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message);
  }

  const body = unwrapApiData(await response.json());
  return normalizeAdminActionResult(body);
}

function normalizeCompileResult(value: unknown): KnowledgeCompileResult {
  const record = isRecord(value) ? value : {};
  return {
    queuedSpaceCount:
      typeof record.queuedSpaceCount === "number" ? record.queuedSpaceCount : 0,
    jobIds: Array.isArray(record.jobIds)
      ? record.jobIds.filter(
          (jobId): jobId is string => typeof jobId === "string",
        )
      : [],
  };
}

function normalizeAdminActionResult(
  value: unknown,
): KnowledgeAdminActionResult {
  const record = isRecord(value) ? value : {};
  return {
    action: normalizeAdminSpaceAction(record.action),
    ...normalizeCompileResult(record),
  };
}

export async function getKnowledgeDiagnostics(params: {
  spaceIds?: string[];
  limit?: number;
}): Promise<KnowledgeDiagnosticsResult> {
  const response = await fetch("/api/llm-wiki/admin/diagnostics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message);
  }

  return normalizeKnowledgeDiagnostics(unwrapApiData(await response.json()));
}

export async function getKnowledgeGraph(params: {
  spaceId: string;
  limit?: number;
}): Promise<KnowledgeGraphResult> {
  const searchParams = new URLSearchParams({ spaceId: params.spaceId });
  if (params.limit) {
    searchParams.set("limit", String(params.limit));
  }

  const response = await fetch(
    `/api/llm-wiki/graph?${searchParams.toString()}`,
    {
      method: "GET",
      credentials: "include",
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message);
  }

  return normalizeKnowledgeGraph(unwrapApiData(await response.json()));
}

function normalizeKnowledgeQueryResult(value: unknown): KnowledgeQueryResult {
  const record = isRecord(value) ? value : {};
  const citations = Array.isArray(record.citations) ? record.citations : [];
  const snippets = Array.isArray(record.snippets) ? record.snippets : [];
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  const retrievalReasons = Array.isArray(record.retrievalReasons)
    ? record.retrievalReasons
    : [];

  return {
    answer: typeof record.answer === "string" ? record.answer : "",
    citations: citations
      .filter(isRecord)
      .map(normalizeCitation)
      .filter((citation) => citation.sourcePageId || citation.title),
    snippets: snippets
      .filter(isRecord)
      .map((snippet) => {
        const sourceWindows = Array.isArray(snippet.sourceWindows)
          ? snippet.sourceWindows
          : [];
        const reasons = Array.isArray(snippet.retrievalReasons)
          ? snippet.retrievalReasons
          : [];

        return {
          id: readString(snippet.id),
          title: readString(snippet.title),
          text: readString(snippet.text),
          retrievalReasons: reasons.filter(
            (reason): reason is string => typeof reason === "string",
          ),
          sourceWindows: sourceWindows
            .filter(isRecord)
            .map(normalizeSourceWindow)
            .filter((window): window is KnowledgeSourceWindow =>
              Boolean(window),
            ),
        };
      })
      .filter((snippet) => snippet.id && (snippet.text || snippet.title)),
    warnings: warnings.filter(
      (warning): warning is string => typeof warning === "string",
    ),
    retrievalReasons: retrievalReasons.filter(
      (reason): reason is string => typeof reason === "string",
    ),
    budget: normalizeContextBudget(record.budget),
    completenessNotice:
      typeof record.completenessNotice === "string"
        ? record.completenessNotice
        : undefined,
  };
}

function normalizeCitation(citation: Record<string, unknown>) {
  return {
    sourcePageId:
      typeof citation.sourcePageId === "string" ? citation.sourcePageId : "",
    title: typeof citation.title === "string" ? citation.title : "",
    url: typeof citation.url === "string" ? citation.url : "#",
  };
}

function normalizeSourceWindow(
  value: Record<string, unknown>,
): KnowledgeSourceWindow | null {
  const sourceRange = isRecord(value.sourceRange) ? value.sourceRange : {};
  const startOffset = readOptionalNumber(sourceRange.startOffset);
  const endOffset = readOptionalNumber(sourceRange.endOffset);
  if (
    startOffset === undefined ||
    endOffset === undefined ||
    startOffset < 0 ||
    endOffset <= startOffset
  ) {
    return null;
  }

  return {
    ...normalizeCitation(value),
    text: readString(value.text),
    sourceRange: { startOffset, endOffset },
    quoteHash: readString(value.quoteHash),
  };
}

function normalizeContextBudget(
  value: unknown,
): KnowledgeContextBudget | undefined {
  if (!isRecord(value)) return undefined;

  return {
    maxContextLength: readNumber(value.maxContextLength),
    usedContextLength: readNumber(value.usedContextLength),
    remainingContextLength: readNumber(value.remainingContextLength),
    includedItemCount: readNumber(value.includedItemCount),
    omittedItemCount: readNumber(value.omittedItemCount),
    responseReserve: readNumber(value.responseReserve),
    perItemMaxLength: readNumber(value.perItemMaxLength),
  };
}

function normalizeKnowledgeDiagnostics(
  value: unknown,
): KnowledgeDiagnosticsResult {
  const record = isRecord(value) ? value : {};
  const pages = Array.isArray(record.pages) ? record.pages : [];
  const jobs = Array.isArray(record.jobs) ? record.jobs : [];
  const compileStatuses = Array.isArray(record.compileStatuses)
    ? record.compileStatuses
    : [];
  const quarantines = Array.isArray(record.quarantines)
    ? record.quarantines
    : [];

  return {
    pages: pages.filter(isRecord).map((page) => ({
      pageId: readString(page.pageId),
      slugId: readString(page.slugId),
      title: readString(page.title),
      spaceId: readString(page.spaceId),
      spaceName: readString(page.spaceName),
      spaceSlug: readString(page.spaceSlug),
      updatedAt: readString(page.updatedAt),
      deletedAt: typeof page.deletedAt === "string" ? page.deletedAt : null,
      textLength: readNumber(page.textLength),
      knowledgeSourceCount: readNumber(page.knowledgeSourceCount),
      staleSourceCount: readNumber(page.staleSourceCount),
      oldestStaleSourceAt:
        typeof page.oldestStaleSourceAt === "string"
          ? page.oldestStaleSourceAt
          : null,
      knowledgePageSourceCount: readNumber(page.knowledgePageSourceCount),
      knowledgeChunkCount: readNumber(page.knowledgeChunkCount),
      missingEmbeddingChunkCount: readNumber(page.missingEmbeddingChunkCount),
      lastCompiledAt:
        typeof page.lastCompiledAt === "string" ? page.lastCompiledAt : null,
      lastAccessPolicyIndexedAt:
        typeof page.lastAccessPolicyIndexedAt === "string"
          ? page.lastAccessPolicyIndexedAt
          : null,
      staleAccessPolicyCount: readNumber(page.staleAccessPolicyCount),
    })),
    jobs: jobs.filter(isRecord).map((job) => ({
      id: readString(job.id),
      name: readString(job.name),
      state: readString(job.state),
      workspaceId:
        typeof job.workspaceId === "string" ? job.workspaceId : undefined,
      spaceId: typeof job.spaceId === "string" ? job.spaceId : undefined,
      pageIds: Array.isArray(job.pageIds)
        ? job.pageIds.filter(
            (pageId): pageId is string => typeof pageId === "string",
          )
        : [],
      timestamp: readOptionalNumber(job.timestamp),
      processedOn: readOptionalNumber(job.processedOn),
      finishedOn: readOptionalNumber(job.finishedOn),
      failedReason:
        typeof job.failedReason === "string" ? job.failedReason : undefined,
    })),
    compileStatuses: compileStatuses
      .filter(isRecord)
      .map(normalizeCompileStatus),
    retrieval: normalizeRetrievalDiagnostics(record.retrieval),
    quarantines: quarantines.filter(isRecord).map(normalizeQuarantinedArtifact),
    quality: normalizeKnowledgeQuality(record.quality),
  };
}

function normalizeQuarantinedArtifact(
  value: Record<string, unknown>,
): KnowledgeQuarantinedArtifact {
  const reasonCodes = Array.isArray(value.reasonCodes)
    ? value.reasonCodes.filter(
        (reasonCode): reasonCode is string => typeof reasonCode === "string",
      )
    : [];

  return {
    id: readString(value.id),
    workspaceId: readString(value.workspaceId),
    spaceId: readString(value.spaceId),
    artifactId: typeof value.artifactId === "string" ? value.artifactId : null,
    artifactKind:
      typeof value.artifactKind === "string" ? value.artifactKind : null,
    compilerRunId:
      typeof value.compilerRunId === "string" ? value.compilerRunId : null,
    compileTaskId:
      typeof value.compileTaskId === "string" ? value.compileTaskId : null,
    reasonCodes,
    createdAt: readString(value.createdAt),
  };
}

function normalizeCompileStatus(
  value: Record<string, unknown>,
): KnowledgeCompileStatus {
  return {
    spaceId: readString(value.spaceId),
    status: normalizeCompileStatusValue(value.status),
    jobId: readString(value.jobId),
    lastRunId: readString(value.lastRunId),
    durationMs: typeof value.durationMs === "number" ? value.durationMs : null,
    sourceCount: readNumber(value.sourceCount),
    importedArtifactCount: readNumber(value.importedArtifactCount),
    quarantinedArtifactCount: readNumber(value.quarantinedArtifactCount),
    failureReason:
      typeof value.failureReason === "string" ? value.failureReason : undefined,
    updatedAt: readOptionalNumber(value.updatedAt),
  };
}

function normalizeCompileStatusValue(
  value: unknown,
): KnowledgeCompileStatus["status"] {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed"
  ) {
    return value;
  }
  return "queued";
}

function normalizeAdminSpaceAction(value: unknown): KnowledgeAdminSpaceAction {
  if (
    value === "retry_compile" ||
    value === "reindex_access" ||
    value === "mark_stale" ||
    value === "rebuild_embeddings"
  ) {
    return value;
  }
  return "retry_compile";
}

function normalizeRetrievalDiagnostics(value: unknown) {
  if (!isRecord(value)) return undefined;

  return {
    sampleCount: readNumber(value.sampleCount),
    zeroHitRate: readNumber(value.zeroHitRate),
    embeddingFallbackRate: readNumber(value.embeddingFallbackRate),
    averageAuthorizedCandidateCount: readNumber(
      value.averageAuthorizedCandidateCount,
    ),
    averageFilteredCandidateCount: readNumber(
      value.averageFilteredCandidateCount,
    ),
  };
}

function normalizeKnowledgeQuality(value: unknown) {
  if (!isRecord(value)) return undefined;
  const summary = isRecord(value.summary) ? value.summary : {};
  const spaces = Array.isArray(value.spaces) ? value.spaces : [];
  const topIssues = Array.isArray(value.topIssues) ? value.topIssues : [];

  return {
    summary: {
      pageCount: readNumber(summary.pageCount),
      compiledPageCount: readNumber(summary.compiledPageCount),
      stalePageCount: readNumber(summary.stalePageCount),
      missingSourcePageCount: readNumber(summary.missingSourcePageCount),
      missingChunkPageCount: readNumber(summary.missingChunkPageCount),
      missingEmbeddingPageCount: readNumber(summary.missingEmbeddingPageCount),
      healthScore: readNumber(summary.healthScore),
    },
    spaces: spaces.filter(isRecord).map((space) => ({
      spaceId: readString(space.spaceId),
      spaceName: readString(space.spaceName),
      pageCount: readNumber(space.pageCount),
      compiledPageCount: readNumber(space.compiledPageCount),
      stalePageCount: readNumber(space.stalePageCount),
      missingChunkPageCount: readNumber(space.missingChunkPageCount),
      missingEmbeddingPageCount: readNumber(space.missingEmbeddingPageCount),
      oldestStaleSourceAgeHours:
        typeof space.oldestStaleSourceAgeHours === "number"
          ? space.oldestStaleSourceAgeHours
          : null,
      healthScore: readNumber(space.healthScore),
    })),
    topIssues: topIssues.filter(isRecord).map((issue) => ({
      code: readString(issue.code),
      severity: normalizeIssueSeverity(issue.severity),
      message: readString(issue.message),
      affectedPageCount: readNumber(issue.affectedPageCount),
    })),
  };
}

function normalizeIssueSeverity(
  value: unknown,
): KnowledgeQualityIssue["severity"] {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return "low";
}

function normalizeKnowledgeGraph(value: unknown): KnowledgeGraphResult {
  const record = isRecord(value) ? value : {};
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  const edges = Array.isArray(record.edges) ? record.edges : [];
  const insights = isRecord(record.insights) ? record.insights : {};

  return {
    nodes: nodes
      .filter(isRecord)
      .map((node) => ({
        id: readString(node.id),
        title: readString(node.title),
        spaceId: readString(node.spaceId),
        sourcePageId:
          typeof node.sourcePageId === "string" ? node.sourcePageId : undefined,
        kind: (node.kind === "section"
          ? "section"
          : "page") as KnowledgeGraphNode["kind"],
        parentPageId:
          typeof node.parentPageId === "string" ? node.parentPageId : undefined,
        headingPath: Array.isArray(node.headingPath)
          ? node.headingPath.filter(
              (part): part is string => typeof part === "string",
            )
          : undefined,
        excerpt: typeof node.excerpt === "string" ? node.excerpt : undefined,
        artifactKind:
          typeof node.artifactKind === "string" ? node.artifactKind : undefined,
        communityId:
          typeof node.communityId === "string" ? node.communityId : undefined,
        degree: readNumber(node.degree),
      }))
      .filter((node) => node.id),
    edges: edges
      .filter(isRecord)
      .map((edge) => ({
        id: readString(edge.id),
        from: readString(edge.from),
        to: readString(edge.to),
        type: (edge.type === "semantic"
          ? "semantic"
          : edge.type === "contains"
            ? "contains"
            : "link") as "semantic" | "contains" | "link",
        label: readString(edge.label),
        weight: readNumber(edge.weight),
        reasons: Array.isArray(edge.reasons)
          ? edge.reasons.filter(
              (reason): reason is string => typeof reason === "string",
            )
          : [],
      }))
      .filter((edge) => edge.id && edge.from && edge.to),
    insights: {
      isolatedNodeIds: Array.isArray(insights.isolatedNodeIds)
        ? insights.isolatedNodeIds.filter(
            (nodeId): nodeId is string => typeof nodeId === "string",
          )
        : [],
      bridgeNodeIds: Array.isArray(insights.bridgeNodeIds)
        ? insights.bridgeNodeIds.filter(
            (nodeId): nodeId is string => typeof nodeId === "string",
          )
        : [],
      communityCount: readNumber(insights.communityCount),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapApiData(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return "data" in value ? value.data : value;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `HTTP error ${response.status}`;

  try {
    const body = await response.json();
    if (body?.message) {
      return Array.isArray(body.message)
        ? body.message.join(", ")
        : body.message;
    }
  } catch {
    return fallback;
  }

  return fallback;
}
