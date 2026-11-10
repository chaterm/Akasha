export type TaskStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed'
export type RunStatus = 'running' | 'paused' | 'succeeded' | 'failed'

export interface Task {
  id: number
  stage: string
  status: TaskStatus
  params: Record<string, unknown>
  target_kind: string | null
  target_id: number | null
  progress_done: number
  progress_total: number | null
  progress_note: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface AuditEntry {
  id: number
  task_id: number | null
  stage: string
  level: string
  message: string
  at: string
}

export interface TaskDetail extends Task {
  logs: AuditEntry[]
}

export type RunTaskKind = 'compile' | 'query' | 'eval' | 'attribution'

export interface TaskTreeNode {
  kind: RunTaskKind
  id: number
  name: string
  status: RunStatus
  created_at: string
  finished_at: string | null
  tasks: Task[]
  pending_tasks: Task[]
  children: TaskTreeNode[]
}

export interface TaskTree {
  total_tasks: number
  inactive_total: number
  compiles: TaskTreeNode[]
  unlinked_tasks: Task[]
}

export interface Connection {
  base_url: string
  email: string
  password: string
  database_url: string
  timeout_seconds: number
  request_interval_seconds: number
  updated_at: string
  compiles: { id: number; run_id: string; workspace_id: string | null; space_id: string }[]
}

export interface ConnectionTest {
  ok: boolean
  user: { id: string | null; email: string | null; role: string | null }
  workspace: { id: string | null; name: string | null }
  is_owner: boolean
  blocked_compiles: { id: number; run_id: string; reason: string }[]
  owner_warning: string | null
  model_configs: unknown
}

export interface ModelConfig {
  feature: string
  model?: string
  baseUrl?: string
  parameters?: Record<string, unknown>
  apiKeySet?: boolean
}

export interface ModelConfigsView {
  features: string[]
  live: { configs: ModelConfig[] }
  compiles: { id: number; run_id: string; drift: Record<string, boolean> }[]
}

export type ProviderRole = 'judge' | 'attribution' | 'generation'

export interface Provider {
  id: number
  role: ProviderRole
  label: string
  base_url: string
  model: string
  api_key_set: boolean
  updated_at: string
}

export type AkashaFeature = 'compiler' | 'embedding' | 'answer' | 'image'

export interface AkashaModelProvider {
  id: number
  feature: AkashaFeature
  label: string
  base_url: string
  model: string
  parameters: Record<string, unknown>
  api_key_set: boolean
  updated_at: string
}

export interface AkashaModelsView {
  features: AkashaFeature[]
  models: AkashaModelProvider[]
}


export interface ProviderProbe {
  ok: boolean
  failure: string | null
  status: number | null
  reply: string
  detail: string | null
  provider: { base_url: string; model: string; api_key_set: boolean }
}

export interface DatasetFile {
  dataset: string
  kind: 'qa' | 'corpus'
  file: string
  present: boolean
  size_bytes: number | null
  rows: number | null
  error: string | null
}

export interface DatasetEntry {
  name: string
  adapter: string
  provides: string[]
  identity_rules: Record<string, string>
  subset_strategy: string
  downloadable: boolean
  expected_qa_rows: number | null
  files: DatasetFile[]
  files_ready: boolean
  normalized: boolean
  normalized_at: string | null
  qa_rows: number | null
  corpus_rows: number | null
}

export interface Sample {
  sample_id: string
  dataset: string
  dataset_sample_id: string
  question: string
  answers: string[]
  gold_doc_ids: string[]
  metadata: Record<string, unknown>
  gold_titles?: string[]
}

export interface SampleDetail extends Sample {
  gold_docs: { doc_id: string; title: string; text: string }[]
  missing_gold_doc_ids: string[]
}

export interface Paged {
  total: number
  offset: number
  limit: number
}

export interface SampleList extends Paged {
  dataset: string
  samples: Sample[]
}

export interface CorpusList extends Paged {
  dataset: string
  docs: { doc_id: string; title: string; text: string }[]
}

export interface RawSamples extends Paged {
  dataset: string
  kind: 'qa' | 'corpus'
  source_file: string
  rows: Record<string, unknown>[]
}

export interface MetricDefinition {
  name: string
  family: string
  requires: string[]
  kind: 'deterministic' | 'judge'
  higher_is_better: boolean
  per_k: boolean
  description: string
}

export interface MetricsView {
  definitions: MetricDefinition[]
  per_dataset: Record<string, string[]>
  computable_for_all: string[]
  computable_for_some: string[]
}

export interface AttributionRun {
  id: number
  name: string
  eval_id: number
  report_provider_id: number | null
  report: string | null
  report_error: string | null
  report_latency_ms: number | null
  status: RunStatus
  model_label: string | null
  sample_count: number
  success_count: number
  created_at: string
  finished_at: string | null
}

export interface EvalRun {
  id: number
  name: string
  query_id: number
  ks: number[]
  metrics: string[]
  judge_provider_id: number | null
  concurrency: number
  status: RunStatus
  model_label: string | null
  sample_count: number
  success_count: number
  created_at: string
  finished_at: string | null
  attributions: AttributionRun[]
}

export interface QueryStats {
  dataset: string
  responses: number
  failures: number
  latency_mean: number | null
  latency_max: number | null
  timed_responses: number | null
  ttft_ms_mean: number | null
  rewrite_ms_mean: number | null
  retrieval_ms_mean: number | null
  generation_ms_mean: number | null
  server_total_ms_mean: number | null
}

export interface EmbeddingGeneration {
  model: string | null
  dimensions: number | null
  active: boolean
  chunks: number
  embedded: number
  total_tokens: number | null
  duration_ms_sum: number | null
  duration_ms_mean: number | null
  first_created_at: string | null
  last_created_at: string | null
}

export interface EmbeddingCoverage {
  total: number
  matched: number
  ready: boolean
  models: string[]
}

export interface EmbeddingRebuild {
  model: string | null
  batches: number
  chunks: number
  failed: number
  total_tokens: number | null
  duration_ms_sum: number | null
  first_batch_at: string | null
  last_batch_at: string | null
}

export interface CompileEmbedding {
  compile_id: number
  space_id: string
  target: { model: string | null; dimensions: number | null }
  coverage: EmbeddingCoverage
  generations: EmbeddingGeneration[]
  rebuilds: EmbeddingRebuild[]
}

export interface QueryRun {
  id: number
  name: string
  compile_id: number
  concurrency: number
  status: RunStatus
  model_label: string | null
  embedding_label: string | null
  embedding_model: string | null
  embedding_concurrency: number | null
  sample_count: number
  success_count: number
  created_at: string
  finished_at: string | null
  stats: Record<string, QueryStats>
  evals: EvalRun[]
}

export interface CompileStats {
  dataset: string
  docs?: number
  imported?: number
  gold?: number
  samples?: number
}

export interface Readiness {
  ready: boolean
  reasons: string[]
  warnings: string[]
}

export interface CompileRun {
  id: number
  run_id: string
  datasets: string[]
  seed: number
  qa_limit: number
  negatives_ratio: number
  space_id: string | null
  space_name: string | null
  workspace_id: string | null
  model_label: string | null
  embedding_label: string | null
  status: RunStatus
  created_at: string
  finished_at: string | null
  stats: Record<string, CompileStats>
  compiled_pages: number | null
  quality: {
    passed: boolean
    gates: Record<string, number | null>
    progress?: { expected?: number; succeeded?: number; failed?: number; skipped?: number }
  } | null

  pace: { runs: number; pages: number; total_ms: number; per_page_ms: number } | null
  readiness: Readiness
  queries: QueryRun[]
}

export interface CompileDoc {
  dataset: string
  doc_id: string
  title: string
  is_gold: number
  page_id: string | null
  error: string | null
}

export interface QueryPreview {
  compile_id: number
  run_id: string
  space_id: string
  question: string
  http_status: number
  latency_ms: number
  error: string | null
  answer_mode: string | null
  answer: unknown
  retrieved_sources: Array<Record<string, unknown>>
  citations: Array<Record<string, unknown>>
  snippets: Array<Record<string, unknown>>
  response: unknown
}

export interface QueryResponseRow {
  sample_id: string
  dataset: string
  question: string
  http_status: number
  latency_ms: number | null
  error: string | null
  answer_mode: string | null
  requested_at: string
  answer: string | null
  retrieved_count: number
  citation_count: number
}

export interface ResponseList extends Paged {
  query_id: number
  count_by_answer_mode: Record<string, number>
  responses: QueryResponseRow[]
}

export type Metrics = Record<string, number>

export interface DatasetEvalSummary {
  dataset: string
  responses_evaluated: number
  http_failures: number
  omitted_metrics: string[]
  answer_modes: Record<string, number>
  scopes: Record<string, Metrics>
}

export interface JudgeSummary {
  total: number
  scored: number
  failed: number
  mean: number | null

  latency_mean: number | null
  failure_rate: number
  failures_by_kind: Record<string, number>
}

export interface EvalDetail {
  id: number
  name: string
  query_id: number
  ks: number[]
  metrics: string[]
  status: RunStatus
  created_at: string
  finished_at: string | null
  query: { id: number; name: string; compile_id: number }
  datasets: DatasetEvalSummary[]
  judge: JudgeSummary
}

export interface EvalSampleDetail {
  sample_id: string
  dataset: string
  answer_mode: string | null
  http_status: number
  answer: string | null
  detail: Record<string, unknown>
  metrics: Metrics
  metric_interpretations: MetricInterpretation[]
  eval_id: number
  query_id: number
  compile_id: number
  response: Record<string, unknown> | null
  gold_pages: Record<string, string | null>
  judge_verdicts: JudgeVerdict[]
}

export interface EvalSampleRow {
  sample_id: string
  dataset: string
  question: string
  answer_mode: string | null
  http_status: number
  answer: string | null
  metrics: Metrics
  judge_verdicts: JudgeVerdict[]
}

export interface EvalSampleList extends Paged {
  eval_id: number
  count_by_answer_mode: Record<string, number>
  samples: EvalSampleRow[]
}

export interface MetricInterpretation {
  name: string
  family: string
  family_label: string
  kind: 'deterministic' | 'judge'
  value: number | null
  higher_is_better: boolean
  description: string
  reason: string
  evidence: MetricEvidence | null
  status: 'good' | 'warning' | 'bad' | 'neutral' | 'unavailable'
}

export interface MetricEvidence {
  formula?: string | null
  documents?: MetricEvidenceDocument[]
  retrieved_documents?: MetricEvidenceDocument[]
  gold_documents?: Array<{
    doc_id: string
    page_id: string | null
    title: string
    retrieved: boolean
    cited: boolean
  }>
  difference_documents?: MetricEvidenceDocument[]
  snippets?: MetricEvidenceSnippet[]
  citation_excerpts?: Array<{
    doc_id: string | null
    page_id: string | null
    title: string
    is_gold: boolean
    excerpts: string[]
  }>
  contributions?: Array<{ rank: number; doc_id: string | null; gain: number }>
  exclusive_gold_doc_ids?: string[]
  answer_comparison?: {
    answer: string
    normalized_answer?: string
    references: Array<string | MetricAnswerReference>
  }
  judge_detail?: Record<string, unknown>
}

export interface MetricEvidenceDocument {
  rank: number
  doc_id: string | null
  page_id: string
  title: string
  is_gold: boolean
  mapped: boolean
}

export interface MetricEvidenceSnippet {
  rank: number
  id?: string | null
  knowledge_page_id?: string
  title: string
  text: string
  retrieval_reasons: string[]
  origin?: 'direct' | 'graph' | null
  page_ids: string[]
  doc_ids: string[]
  gold_doc_ids: string[]
  is_gold: boolean
  is_graph: boolean
}

export interface MetricAnswerReference {
  text: string
  normalized: string
  exact_match: number
  answer_token_count: number
  reference_token_count: number
  shared_token_count: number
  shared_tokens: string[]
  precision: number
  recall: number
  f1: number
}

export interface JudgeVerdict {
  sample_id: string
  metric: string
  score: number | null
  failure_kind: string | null
  latency_ms: number | null
  detail: Record<string, unknown> | null
}

export interface Snippet {
  id?: string
  knowledgePageId?: string
  title?: string
  text?: string
  origin?: 'direct' | 'graph'
  retrievalReasons?: string[]
  sourceWindows?: { sourcePageId?: string }[]
  score?: number
}

export type RootCause =
  | 'answer_incorrect'
  | 'answer_correct'
  | 'generation_ignored_retrieval'
  | 'generation_fallback'
  | 'generation_empty'
  | 'retrieval_evidence_incomplete'
  | 'compiled_answer_missing'
  | 'compiled_away'
  | 'citation_dropped'
  | 'retrieval_miss'
  | 'graph_edge_missing'
  | 'unknown'

export interface AttributionResult {
  sample_id: string
  dataset: string
  root_cause: RootCause
  evidence: Record<string, unknown>
}

export interface QueryAuditSnapshot {
  answerMode?: string
  decisionReason?: string
  generalAnswerReason?: string
  authorizedChunkCount?: number
  finalAuthorizedSourceCount?: number
  packContextLength?: number
  answerContextLength?: number
  contextBudget?: number
  packContextBudget?: number
  answerContextBudget?: number
  truncatedCount?: number
  budget?: {
    includedItemCount?: number
    omittedItemCount?: number
    maxContextLength?: number
    usedContextLength?: number
  }
  graph?: { candidateCount?: number; selectedCount?: number; gatedOutCount?: number }
  retrieval?: {
    topK?: number
    threshold?: number
    dropped?: Array<{
      reason?: string
      pageId?: string
      chunkId?: string
      title?: string
      text?: string
    }>
  }
}

export interface EvidenceChainStep {
  position: number
  question?: string
  answer?: string
  support_doc_id?: string
  support_title?: string
  status: 'supported' | 'partial' | 'missing' | string
  answer_present?: boolean
  support_title_present?: boolean
  support_token_recall?: number
  claim_retrieved?: boolean
  retrieved_evidence?: Array<{
    source_type: 'context' | 'source_window'
    title: string
    text: string
    support_overlap: number
    answer_match: boolean
  }>
}

export interface EvidenceChain {
  status: 'complete' | 'partial' | 'incomplete' | 'unavailable' | string
  step_count?: number
  supported_step_count?: number
  partial_step_count?: number
  missing_step_count?: number
  model_false_negative_candidate?: boolean
  steps?: EvidenceChainStep[]
}

export interface CompiledAnswerStep {
  position: number
  question?: string
  answer?: string
  support_doc_id?: string
  support_title?: string
  source_answer_present?: boolean
  compiled_answer_present?: boolean
  source_answer_token_recall?: number
  compiled_answer_token_recall?: number
  status: 'preserved' | 'compiled_missing' | 'compiled_only' | 'source_missing' | string
}

export interface CompiledAnswers {
  status: 'preserved' | 'compiled_missing' | 'unavailable' | string
  step_count?: number
  compiled_missing_count?: number
  source_missing_count?: number
  answer_token_recall_threshold?: number
  reason?: string
  steps?: CompiledAnswerStep[]
}

export interface AttributionDetail extends AttributionRun {
  count_by_root_cause: Record<string, number>
  results: AttributionResult[]
}

export interface Lineage {
  source_page_id: string | null
  source: { text: string; chunk_count: number; note: string }
  compiled: { text: string; chunk_count: number; artifact_count: number; note: string }
  diff: {
    expansion_ratio: number | null
    retention: number | null
    dropped: string[]
    dropped_total: number
    added: string[]
    added_total: number
  }
  question_terms_lost: string[]
  verdict: string
  artifacts: { id: string; title: string | null; page_type: string | null }[]
  chunks: { knowledge_page_id: string; title: string | null; chunk_role: string | null; text: string }[]
  source_chunks: { text: string }[]
}
