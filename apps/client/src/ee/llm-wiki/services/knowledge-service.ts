import type {
  KnowledgeAdminActionResult,
  KnowledgeAdminSpaceAction,
  KnowledgeContextBudget,
  KnowledgeCompileResult,
  KnowledgeCompileSpacesResult,
  KnowledgeCompileRunDisposition,
  KnowledgeSpaceOperationResult,
  KnowledgeGraphNode,
  KnowledgeGraphResult,
  KnowledgeQueryResult,
  KnowledgeQueueSnapshot,
  KnowledgeQualityIssue,
  KnowledgeQualityReport,
  KnowledgeQuarantineDiagnosticsPage,
  KnowledgeQuarantinedArtifact,
  KnowledgeRetrievalDiagnosticsSummary,
  KnowledgeRetryPagesResult,
  KnowledgeRunDiagnostic,
  KnowledgeRunDiagnosticsPage,
  KnowledgeRunDiagnosticsSummary,
  KnowledgeRunPageDiagnosticsPage,
  KnowledgeRunPhase,
  KnowledgeRunStatus,
  KnowledgeSourceWindow,
  KnowledgeWorkerDiagnostics,
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
}): Promise<KnowledgeCompileSpacesResult> {
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
  return normalizeCompileSpacesResult(body);
}

export async function updateKnowledgeSpace(params: {
  spaceId: string;
  confirmationSpaceName: string;
}): Promise<KnowledgeSpaceOperationResult> {
  return requestConfirmedSpaceCompilation(params, "update-knowledge");
}

export async function forceRebuildKnowledgeSpace(params: {
  spaceId: string;
  confirmationSpaceName: string;
}): Promise<KnowledgeSpaceOperationResult> {
  return requestConfirmedSpaceCompilation(params, "force-rebuild-knowledge");
}

async function requestConfirmedSpaceCompilation(
  params: { spaceId: string; confirmationSpaceName: string },
  endpoint: "update-knowledge" | "force-rebuild-knowledge",
): Promise<KnowledgeSpaceOperationResult> {
  const response = await fetch(
    `/api/llm-wiki/admin/spaces/${encodeURIComponent(params.spaceId)}/${endpoint}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        confirmationSpaceName: params.confirmationSpaceName,
      }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message);
  }

  return normalizeSpaceOperationResult(unwrapApiData(await response.json()));
}

function normalizeCompileSpacesResult(
  value: unknown,
): KnowledgeCompileSpacesResult {
  const record = isRecord(value) ? value : {};
  const runs = Array.isArray(record.runs)
    ? record.runs.flatMap((value) => {
        if (!isRecord(value)) return [];
        if (
          typeof value.spaceId !== "string" ||
          typeof value.runId !== "string" ||
          !isCompileRunDisposition(value.disposition)
        ) {
          return [];
        }
        return [
          {
            spaceId: value.spaceId,
            runId: value.runId,
            disposition: value.disposition,
          },
        ];
      })
    : [];
  return {
    requestedSpaceCount: numberOrZero(record.requestedSpaceCount),
    acceptedRunCount: numberOrZero(record.acceptedRunCount),
    coalescedRunCount: numberOrZero(record.coalescedRunCount),
    rerunRequestedCount: numberOrZero(record.rerunRequestedCount),
    runs,
  };
}

function normalizeSpaceOperationResult(
  value: unknown,
): KnowledgeSpaceOperationResult {
  const record = isRecord(value) ? value : {};
  return {
    runId: typeof record.runId === "string" ? record.runId : "",
    mode: record.mode === "force_rebuild" ? "force_rebuild" : "incremental",
    knowledgeGeneration: numberOrZero(record.knowledgeGeneration),
  };
}

function isCompileRunDisposition(
  value: unknown,
): value is KnowledgeCompileRunDisposition {
  return ["created", "coalesced", "rerun_requested"].includes(value as string);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

export async function getKnowledgeRunDiagnosticsSummary(params: {
  spaceIds?: string[];
}): Promise<KnowledgeRunDiagnosticsSummary> {
  const value = await postKnowledgeDiagnostics(
    "/api/llm-wiki/admin/diagnostics/summary",
    params,
  );
  return normalizeRunDiagnosticsSummary(value);
}

export async function getKnowledgeRunDiagnostics(params: {
  spaceIds?: string[];
  statuses?: KnowledgeRunStatus[];
  phases?: KnowledgeRunPhase[];
  search?: string;
  page?: number;
  limit?: number;
}): Promise<KnowledgeRunDiagnosticsPage> {
  const value = await postKnowledgeDiagnostics(
    "/api/llm-wiki/admin/diagnostics/runs",
    params,
  );
  return normalizeRunDiagnosticsPage(value);
}

export async function getKnowledgeRunPageDiagnostics(params: {
  runId: string;
  page?: number;
  limit?: number;
}): Promise<KnowledgeRunPageDiagnosticsPage> {
  const query = new URLSearchParams({
    page: String(params.page ?? 1),
    limit: String(params.limit ?? 50),
  });
  const response = await fetch(
    `/api/llm-wiki/admin/diagnostics/runs/${encodeURIComponent(params.runId)}/pages?${query}`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return normalizeRunPageDiagnosticsPage(unwrapApiData(await response.json()));
}

export async function getKnowledgeWorkerDiagnostics(): Promise<KnowledgeWorkerDiagnostics> {
  const response = await fetch("/api/llm-wiki/admin/diagnostics/workers", {
    credentials: "include",
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return normalizeWorkerDiagnostics(unwrapApiData(await response.json()));
}

export async function getKnowledgeQualityDiagnostics(params: {
  spaceIds?: string[];
}): Promise<KnowledgeQualityReport> {
  return normalizeKnowledgeQuality(
    await postKnowledgeDiagnostics(
      "/api/llm-wiki/admin/diagnostics/quality",
      params,
    ),
  );
}

export async function getKnowledgeQuarantineDiagnostics(params: {
  spaceIds?: string[];
  page?: number;
  limit?: number;
}): Promise<KnowledgeQuarantineDiagnosticsPage> {
  return normalizeQuarantineDiagnosticsPage(
    await postKnowledgeDiagnostics(
      "/api/llm-wiki/admin/diagnostics/quarantine",
      params,
    ),
  );
}

export async function getKnowledgeRetrievalDiagnostics(): Promise<KnowledgeRetrievalDiagnosticsSummary> {
  const response = await fetch("/api/llm-wiki/admin/diagnostics/retrieval", {
    credentials: "include",
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return normalizeRetrievalDiagnostics(unwrapApiData(await response.json()));
}

async function postKnowledgeDiagnostics(
  endpoint: string,
  params: unknown,
): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(params),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return unwrapApiData(await response.json());
}

export async function retryKnowledgePages(params: {
  pageIds: string[];
}): Promise<KnowledgeRetryPagesResult> {
  const response = await fetch("/api/llm-wiki/admin/retry-pages", {
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
  const record = isRecord(body) ? body : {};
  return {
    queuedPageCount: readNumber(record.queuedPageCount),
    jobIds: Array.isArray(record.jobIds)
      ? record.jobIds.filter(
          (jobId): jobId is string => typeof jobId === "string",
        )
      : [],
  };
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

function normalizeRunDiagnosticsSummary(
  value: unknown,
): KnowledgeRunDiagnosticsSummary {
  const record = isRecord(value) ? value : {};
  const dispatch = isRecord(record.dispatch) ? record.dispatch : {};
  const recovery = isRecord(record.recovery) ? record.recovery : {};
  const failures = isRecord(record.failureCategories)
    ? record.failureCategories
    : {};
  const events = isRecord(record.workerEvents) ? record.workerEvents : {};
  const queues = isRecord(record.queues) ? record.queues : undefined;
  return {
    sampledAt: readString(record.sampledAt),
    activeRunCount: readNumber(record.activeRunCount),
    activeSpaceSlotRunCount: readNumber(record.activeSpaceSlotRunCount),
    waitingInitializationCount: readNumber(record.waitingInitializationCount),
    queuedRunCount: readNumber(record.queuedRunCount),
    recentCompletedCount: readNumber(record.recentCompletedCount),
    recentFailedCount: readNumber(record.recentFailedCount),
    recentYieldCount: readNumber(record.recentYieldCount),
    longestCurrentSlotWaitMs:
      typeof record.longestCurrentSlotWaitMs === "number"
        ? record.longestCurrentSlotWaitMs
        : null,
    statusCounts: normalizeNumberRecord(record.statusCounts),
    phaseCounts: normalizeNumberRecord(record.phaseCounts),
    imageStatusCounts: normalizeNumberRecord(record.imageStatusCounts),
    dispatch: {
      spaceUnacknowledged: readNumber(dispatch.spaceUnacknowledged),
      imageUnacknowledged: readNumber(dispatch.imageUnacknowledged),
    },
    recovery: {
      expiredExecutionLeases: readNumber(recovery.expiredExecutionLeases),
      spaceRecovering: readNumber(recovery.spaceRecovering),
      spaceRecoveryExhausted: readNumber(recovery.spaceRecoveryExhausted),
      imageRecovering: readNumber(recovery.imageRecovering),
      imageRecoveryExhausted: readNumber(recovery.imageRecoveryExhausted),
    },
    failureCategories: {
      budgetTimeout: readNumber(failures.budgetTimeout),
      provider: readNumber(failures.provider),
      publication: readNumber(failures.publication),
      infrastructure: readNumber(failures.infrastructure),
      other: readNumber(failures.other),
    },
    ...(queues
      ? {
          queues: {
            space: normalizeKnowledgeQueueSnapshot(queues.space),
            image: normalizeKnowledgeQueueSnapshot(queues.image),
          },
        }
      : {}),
    workerEvents: {
      windowMs: readNumber(events.windowMs),
      stalled: readNumber(events.stalled),
      lockRenewalFailed: readNumber(events.lockRenewalFailed),
      source: "process_local",
    },
  };
}

function normalizeRunDiagnosticsPage(
  value: unknown,
): KnowledgeRunDiagnosticsPage {
  const record = isRecord(value) ? value : {};
  return {
    items: Array.isArray(record.items)
      ? record.items.filter(isRecord).map(normalizeRunDiagnostic)
      : [],
    total: readNumber(record.total),
    page: Math.max(readNumber(record.page), 1),
    limit: Math.max(readNumber(record.limit), 1),
  };
}

function normalizeRunDiagnostic(
  value: Record<string, unknown>,
): KnowledgeRunDiagnostic {
  const progress = isRecord(value.progress) ? value.progress : {};
  const text = isRecord(progress.text) ? progress.text : {};
  const images = isRecord(progress.images) ? progress.images : {};
  const merge = isRecord(progress.merge) ? progress.merge : {};
  const queueState = [
    "waiting_initialization",
    "text_continuation",
    "image_merge_continuation",
    "queued",
  ].includes(value.queueState as string)
    ? (value.queueState as KnowledgeRunDiagnostic["queueState"])
    : null;
  return {
    runId: readString(value.runId),
    spaceId: readString(value.spaceId),
    spaceName: readString(value.spaceName),
    status: normalizeRunStatus(value.status),
    mode: value.mode === "force_rebuild" ? "force_rebuild" : "incremental",
    phase: normalizeRunPhase(value.phase),
    knowledgeGeneration: readNumber(value.knowledgeGeneration),
    queueState,
    spaceJobSequence: readNumber(value.spaceJobSequence),
    lastYieldAt: readNullableString(value.lastYieldAt),
    lastYieldReason: readNullableString(value.lastYieldReason),
    workerId: readNullableString(value.workerId),
    errorCode: readNullableString(value.errorCode),
    initializedAt: readNullableString(value.initializedAt),
    queuedAt: readString(value.queuedAt),
    startedAt: readNullableString(value.startedAt),
    finishedAt: readNullableString(value.finishedAt),
    createdAt: readString(value.createdAt),
    updatedAt: readString(value.updatedAt),
    runDurationMs: readNumber(value.runDurationMs),
    currentSliceWaitMs:
      typeof value.currentSliceWaitMs === "number"
        ? value.currentSliceWaitMs
        : null,
    progress: {
      text: {
        expected: readNumber(text.expected),
        succeeded: readNumber(text.succeeded),
        failed: readNumber(text.failed),
        skipped: readNumber(text.skipped),
      },
      images: {
        expected: readNumber(images.expected),
        succeeded: readNumber(images.succeeded),
      },
      merge: {
        expected: readNumber(merge.expected),
        succeeded: readNumber(merge.succeeded),
      },
    },
  };
}

function normalizeRunPageDiagnosticsPage(
  value: unknown,
): KnowledgeRunPageDiagnosticsPage {
  const record = isRecord(value) ? value : {};
  const run = isRecord(record.run) ? record.run : {};
  return {
    run: {
      runId: readString(run.runId),
      spaceId: readString(run.spaceId),
      spaceName: readString(run.spaceName),
    },
    items: Array.isArray(record.items)
      ? record.items.filter(isRecord).map((item) => {
          const imageFailures = isRecord(item.imageFailures)
            ? item.imageFailures
            : {};
          const errorCategory = [
            "budget_timeout",
            "provider",
            "publication",
            "infrastructure",
            "other",
          ].includes(item.errorCategory as string)
            ? (item.errorCategory as KnowledgeRunPageDiagnosticsPage["items"][number]["errorCategory"])
            : null;
          return {
            runPageId: readString(item.runPageId),
            sourcePageId: readString(item.sourcePageId),
            title: readString(item.title),
            slugId: readNullableString(item.slugId),
            status: readString(item.status),
            imageStatus: readString(item.imageStatus),
            mergeStatus: readString(item.mergeStatus),
            expectedImageCount: readNumber(item.expectedImageCount),
            succeededImageCount: readNumber(item.succeededImageCount),
            failedImageCount: readNumber(item.failedImageCount),
            skippedImageCount: readNumber(item.skippedImageCount),
            errorCode: readNullableString(item.errorCode),
            errorCategory,
            errorSummary: readNullableString(item.errorSummary),
            ...(typeof item.errorDetail === "string"
              ? { errorDetail: item.errorDetail }
              : {}),
            queuedAt: readNullableString(item.queuedAt),
            startedAt: readNullableString(item.startedAt),
            finishedAt: readNullableString(item.finishedAt),
            updatedAt: readString(item.updatedAt),
            imageFailures: {
              retryableExhausted: readNumber(imageFailures.retryableExhausted),
              permanent: readNumber(imageFailures.permanent),
            },
          };
        })
      : [],
    total: readNumber(record.total),
    page: Math.max(readNumber(record.page), 1),
    limit: Math.max(readNumber(record.limit), 1),
  };
}

function normalizeWorkerDiagnostics(
  value: unknown,
): KnowledgeWorkerDiagnostics {
  const record = isRecord(value) ? value : {};
  return {
    sampledAt: readString(record.sampledAt),
    databaseMaxPool: readNumber(record.databaseMaxPool),
    schedulingAuthority: "postgresql",
    space: normalizeWorkerCapacity(record.space),
    image: normalizeWorkerCapacity(record.image),
  };
}

function normalizeWorkerCapacity(value: unknown) {
  const record = isRecord(value) ? value : {};
  const source = ["bullmq_client_list", "unsupported", "unavailable"].includes(
    record.source as string,
  )
    ? (record.source as "bullmq_client_list" | "unsupported" | "unavailable")
    : "unavailable";
  return {
    workerCount:
      typeof record.workerCount === "number" ? record.workerCount : null,
    capacity: typeof record.capacity === "number" ? record.capacity : null,
    exact: false as const,
    source,
    concurrency: readNumber(record.concurrency),
    lockDuration: readNumber(record.lockDuration),
    stalledInterval: readNumber(record.stalledInterval),
    maxStalledCount: readNumber(record.maxStalledCount),
  };
}

function normalizeKnowledgeQuality(value: unknown): KnowledgeQualityReport {
  const record = isRecord(value) ? value : {};
  const summary = isRecord(record.summary) ? record.summary : {};
  const spaces = Array.isArray(record.spaces) ? record.spaces : [];
  const topIssues = Array.isArray(record.topIssues) ? record.topIssues : [];
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
  return value === "high" || value === "medium" || value === "low"
    ? value
    : "low";
}

function normalizeQuarantineDiagnosticsPage(
  value: unknown,
): KnowledgeQuarantineDiagnosticsPage {
  const record = isRecord(value) ? value : {};
  return {
    items: Array.isArray(record.items)
      ? record.items.filter(isRecord).map(normalizeQuarantinedArtifact)
      : [],
    total: readNumber(record.total),
    page: Math.max(readNumber(record.page), 1),
    limit: Math.max(readNumber(record.limit), 1),
  };
}

function normalizeQuarantinedArtifact(
  value: Record<string, unknown>,
): KnowledgeQuarantinedArtifact {
  return {
    id: readString(value.id),
    workspaceId: readString(value.workspaceId),
    spaceId: readString(value.spaceId),
    artifactId: readNullableString(value.artifactId),
    artifactKind: readNullableString(value.artifactKind),
    compilerRunId: readNullableString(value.compilerRunId),
    compileTaskId: readNullableString(value.compileTaskId),
    reasonCodes: Array.isArray(value.reasonCodes)
      ? value.reasonCodes.filter(
          (reason): reason is string => typeof reason === "string",
        )
      : [],
    createdAt: readString(value.createdAt),
  };
}

function normalizeRetrievalDiagnostics(
  value: unknown,
): KnowledgeRetrievalDiagnosticsSummary {
  const record = isRecord(value) ? value : {};
  return {
    sampleCount: readNumber(record.sampleCount),
    zeroHitRate: readNumber(record.zeroHitRate),
    embeddingFallbackRate: readNumber(record.embeddingFallbackRate),
    accessPolicyFallbackRate: readNumber(record.accessPolicyFallbackRate),
    averageAuthorizedCandidateCount: readNumber(
      record.averageAuthorizedCandidateCount,
    ),
    averageFilteredCandidateCount: readNumber(
      record.averageFilteredCandidateCount,
    ),
  };
}

function normalizeNumberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, count]) => [key, readNumber(count)]),
  );
}

function normalizeRunStatus(value: unknown): KnowledgeRunStatus {
  return [
    "queued",
    "compiling",
    "aggregate_pending",
    "aggregating",
    "succeeded",
    "partial",
    "failed",
    "superseded",
  ].includes(value as string)
    ? (value as KnowledgeRunStatus)
    : "queued";
}

function normalizeRunPhase(value: unknown): KnowledgeRunPhase {
  return [
    "text",
    "initial_aggregate",
    "images",
    "image_merge",
    "final_aggregate",
    "complete",
  ].includes(value as string)
    ? (value as KnowledgeRunPhase)
    : "text";
}

function normalizeKnowledgeQueueCounts(value: unknown) {
  const counts = isRecord(value) ? value : {};
  return {
    waiting: readNumber(counts.waiting),
    active: readNumber(counts.active),
    delayed: readNumber(counts.delayed),
    prioritized: readNumber(counts.prioritized),
    waitingChildren: readNumber(counts.waitingChildren),
    paused: readNumber(counts.paused),
    failed: readNumber(counts.failed),
    completed: readNumber(counts.completed),
  };
}

function normalizeKnowledgeQueueSnapshot(
  value: unknown,
): KnowledgeQueueSnapshot {
  const record = isRecord(value) ? value : {};
  return {
    ...normalizeKnowledgeQueueCounts(record),
    sampledAt: typeof record.sampledAt === "string" ? record.sampledAt : null,
  };
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

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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
