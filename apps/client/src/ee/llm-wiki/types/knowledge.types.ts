export interface KnowledgeCitation {
  sourcePageId: string;
  title: string;
  url: string;
}

export interface KnowledgeSourceRange {
  startOffset: number;
  endOffset: number;
}

export interface KnowledgeSourceWindow extends KnowledgeCitation {
  text: string;
  sourceRange: KnowledgeSourceRange;
  quoteHash: string;
}

export interface KnowledgeSnippet {
  id: string;
  title: string;
  text: string;
  retrievalReasons: string[];
  sourceWindows: KnowledgeSourceWindow[];
}

export interface KnowledgeContextBudget {
  maxContextLength: number;
  usedContextLength: number;
  remainingContextLength: number;
  includedItemCount: number;
  omittedItemCount: number;
  responseReserve: number;
  perItemMaxLength: number;
}

export interface KnowledgeQueryResult {
  answer: string;
  citations: KnowledgeCitation[];
  snippets: KnowledgeSnippet[];
  warnings: string[];
  retrievalReasons: string[];
  budget?: KnowledgeContextBudget;
  completenessNotice?: string;
}

export interface KnowledgeCompileResult {
  queuedSpaceCount: number;
  jobIds: string[];
}

export type KnowledgeCompileRunDisposition =
  | "created"
  | "coalesced"
  | "rerun_requested";

export interface KnowledgeCompileSpacesResult {
  requestedSpaceCount: number;
  acceptedRunCount: number;
  coalescedRunCount: number;
  rerunRequestedCount: number;
  runs: Array<{
    spaceId: string;
    runId: string;
    disposition: KnowledgeCompileRunDisposition;
  }>;
}

export interface KnowledgeSpaceOperationResult {
  runId: string;
  mode: "incremental" | "force_rebuild";
  knowledgeGeneration: number;
}

export type KnowledgeAdminSpaceAction =
  | "retry_compile"
  | "reindex_access"
  | "mark_stale"
  | "rebuild_embeddings";

export interface KnowledgeAdminActionResult extends KnowledgeCompileResult {
  action: KnowledgeAdminSpaceAction;
}

export interface KnowledgeRetryPagesResult {
  queuedPageCount: number;
  jobIds: string[];
}

export interface KnowledgeQueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  prioritized: number;
  waitingChildren: number;
  paused: number;
  failed: number;
  completed: number;
}

export interface KnowledgeQueueSnapshot extends KnowledgeQueueCounts {
  sampledAt: string | null;
}

export type KnowledgeRunStatus =
  | "queued"
  | "compiling"
  | "aggregate_pending"
  | "aggregating"
  | "succeeded"
  | "partial"
  | "failed"
  | "superseded";

export type KnowledgeRunPhase =
  | "text"
  | "initial_aggregate"
  | "images"
  | "image_merge"
  | "final_aggregate"
  | "complete";

export interface KnowledgeRunDiagnosticsSummary {
  sampledAt: string;
  activeRunCount: number;
  activeSpaceSlotRunCount: number;
  waitingInitializationCount: number;
  queuedRunCount: number;
  recentCompletedCount: number;
  recentFailedCount: number;
  recentYieldCount: number;
  longestCurrentSlotWaitMs: number | null;
  statusCounts: Record<string, number>;
  phaseCounts: Record<string, number>;
  imageStatusCounts: Record<string, number>;
  dispatch: {
    spaceUnacknowledged: number;
    imageUnacknowledged: number;
  };
  recovery: {
    expiredExecutionLeases: number;
    spaceRecovering: number;
    spaceRecoveryExhausted: number;
    imageRecovering: number;
    imageRecoveryExhausted: number;
  };
  failureCategories: {
    budgetTimeout: number;
    provider: number;
    publication: number;
    infrastructure: number;
    other: number;
  };
  queues?: {
    space: KnowledgeQueueSnapshot;
    image: KnowledgeQueueSnapshot;
  };
  workerEvents: {
    windowMs: number;
    stalled: number;
    lockRenewalFailed: number;
    source: "process_local";
  };
}

export interface KnowledgeRunDiagnostic {
  runId: string;
  spaceId: string;
  spaceName: string;
  status: KnowledgeRunStatus;
  mode: "incremental" | "force_rebuild";
  phase: KnowledgeRunPhase;
  knowledgeGeneration: number;
  queueState:
    | "waiting_initialization"
    | "text_continuation"
    | "image_merge_continuation"
    | "queued"
    | null;
  spaceJobSequence: number;
  lastYieldAt: string | null;
  lastYieldReason: string | null;
  workerId: string | null;
  errorCode: string | null;
  initializedAt: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  runDurationMs: number;
  currentSliceWaitMs: number | null;
  progress: {
    text: KnowledgeRunProgressCount;
    images: Pick<KnowledgeRunProgressCount, "expected" | "succeeded">;
    merge: Pick<KnowledgeRunProgressCount, "expected" | "succeeded">;
  };
}

export interface KnowledgeRunProgressCount {
  expected: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface KnowledgeRunDiagnosticsPage {
  items: KnowledgeRunDiagnostic[];
  total: number;
  page: number;
  limit: number;
}

export interface KnowledgeRunPageDiagnostic {
  runPageId: string;
  sourcePageId: string;
  title: string;
  slugId: string | null;
  status: string;
  imageStatus: string;
  mergeStatus: string;
  expectedImageCount: number;
  succeededImageCount: number;
  failedImageCount: number;
  skippedImageCount: number;
  errorCode: string | null;
  errorCategory:
    | "budget_timeout"
    | "provider"
    | "publication"
    | "infrastructure"
    | "other"
    | null;
  errorSummary: string | null;
  errorDetail?: string;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  imageFailures: {
    retryableExhausted: number;
    permanent: number;
  };
}

export interface KnowledgeRunPageDiagnosticsPage {
  run: { runId: string; spaceId: string; spaceName: string };
  items: KnowledgeRunPageDiagnostic[];
  total: number;
  page: number;
  limit: number;
}

export interface KnowledgeWorkerCapacityEstimate {
  workerCount: number | null;
  capacity: number | null;
  exact: false;
  source: "bullmq_client_list" | "unsupported" | "unavailable";
  concurrency: number;
  lockDuration: number;
  stalledInterval: number;
  maxStalledCount: number;
}

export interface KnowledgeWorkerDiagnostics {
  sampledAt: string;
  databaseMaxPool: number;
  schedulingAuthority: "postgresql";
  space: KnowledgeWorkerCapacityEstimate;
  image: KnowledgeWorkerCapacityEstimate;
}

export interface KnowledgeGraphNode {
  id: string;
  title: string;
  spaceId: string;
  sourcePageId?: string;
  kind: "page" | "section";
  parentPageId?: string;
  headingPath?: string[];
  excerpt?: string;
  degree: number;
  artifactKind?: string;
  communityId?: string;
}

export interface KnowledgeGraphEdge {
  id: string;
  from: string;
  to: string;
  type: "link" | "semantic" | "contains";
  label: string;
  weight: number;
  reasons: string[];
}

export interface KnowledgeGraphInsights {
  isolatedNodeIds: string[];
  bridgeNodeIds: string[];
  communityCount: number;
}

export interface KnowledgeGraphResult {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  insights: KnowledgeGraphInsights;
}
