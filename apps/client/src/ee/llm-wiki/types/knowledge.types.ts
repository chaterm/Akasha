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

export type KnowledgePageCompileStatus =
  | "not_started"
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export type KnowledgePageCompileStage =
  | "queued"
  | "read_source"
  | "analysis"
  | "generation"
  | "merge"
  | "validation"
  | "import"
  | "completed";

export interface KnowledgeDiagnosticsPage {
  pageId: string;
  slugId: string;
  title: string;
  spaceId: string;
  spaceName: string;
  spaceSlug: string;
  updatedAt: string;
  deletedAt: string | null;
  textLength: number;
  knowledgeSourceCount: number;
  staleSourceCount: number;
  oldestStaleSourceAt: string | null;
  knowledgePageSourceCount: number;
  knowledgeChunkCount: number;
  missingEmbeddingChunkCount: number;
  lastCompiledAt: string | null;
  lastAccessPolicyIndexedAt: string | null;
  staleAccessPolicyCount: number;
  compileStatus: KnowledgePageCompileStatus;
  compileStage: KnowledgePageCompileStage | null;
  compileAttemptCount: number;
  compileErrorCode: string | null;
  compileErrorMessage: string | null;
  lastSucceededAt: string | null;
  servingLastSuccessfulVersion: boolean;
}

export interface KnowledgeDiagnosticsJob {
  id: string;
  name: string;
  state: string;
  workspaceId?: string;
  spaceId?: string;
  pageIds: string[];
  timestamp?: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason?: string;
}

export interface KnowledgeCompileStatus {
  spaceId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  jobId: string;
  lastRunId: string;
  durationMs: number | null;
  sourceCount: number;
  importedArtifactCount: number;
  quarantinedArtifactCount: number;
  failureReason?: string;
  updatedAt?: number;
}

export interface KnowledgeQuarantinedArtifact {
  id: string;
  workspaceId: string;
  spaceId: string;
  artifactId: string | null;
  artifactKind: string | null;
  compilerRunId: string | null;
  compileTaskId: string | null;
  reasonCodes: string[];
  createdAt: string;
}

export interface KnowledgeDiagnosticsResult {
  pages: KnowledgeDiagnosticsPage[];
  jobs: KnowledgeDiagnosticsJob[];
  compileStatuses: KnowledgeCompileStatus[];
  retrieval?: KnowledgeRetrievalDiagnosticsSummary;
  quarantines: KnowledgeQuarantinedArtifact[];
  quality?: KnowledgeQualityReport;
}

export interface KnowledgeRetrievalDiagnosticsSummary {
  sampleCount: number;
  zeroHitRate: number;
  embeddingFallbackRate: number;
  accessPolicyFallbackRate: number;
  averageAuthorizedCandidateCount: number;
  averageFilteredCandidateCount: number;
}

export interface KnowledgeQualitySummary {
  pageCount: number;
  compiledPageCount: number;
  stalePageCount: number;
  missingSourcePageCount: number;
  missingChunkPageCount: number;
  missingEmbeddingPageCount: number;
  healthScore: number;
}

export interface KnowledgeSpaceHealth {
  spaceId: string;
  spaceName: string;
  pageCount: number;
  compiledPageCount: number;
  stalePageCount: number;
  missingChunkPageCount: number;
  missingEmbeddingPageCount: number;
  oldestStaleSourceAgeHours: number | null;
  healthScore: number;
}

export interface KnowledgeQualityIssue {
  code: string;
  severity: "high" | "medium" | "low";
  message: string;
  affectedPageCount: number;
}

export interface KnowledgeQualityReport {
  summary: KnowledgeQualitySummary;
  spaces: KnowledgeSpaceHealth[];
  topIssues: KnowledgeQualityIssue[];
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
