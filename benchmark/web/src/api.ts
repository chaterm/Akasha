import type {
  AkashaModelsView,
  AttributionDetail,
  CompileDoc,
  CompileEmbedding,
  CompileRun,
  Connection,
  ConnectionTest,
  CorpusList,
  DatasetEntry,
  EvalDetail,
  EvalSampleDetail,
  EvalSampleList,
  Lineage,
  MetricsView,
  ModelConfigsView,
  Paged,
  Provider,
  ProviderProbe,
  ProviderRole,
  QueryPreview,
  RawSamples,
  ResponseList,
  SampleDetail,
  SampleList,
  Task,
  TaskDetail,
  TaskTree,
} from './types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const apiBase = import.meta.env.BASE_URL.replace(/\/$/, '')
  const requestPath = path.startsWith('/api') ? `${apiBase}${path}` : path
  const response = await fetch(requestPath, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { detail?: string }
      if (body.detail) detail = body.detail
    } catch {
    }
    throw new ApiError(response.status, detail)
  }
  return (await response.json()) as T
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) })

const del = <T>(path: string) => request<T>(path, { method: 'DELETE' })

const query = (params: Record<string, string | number | boolean | undefined>) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const api = {
  connection: () => request<Connection>('/api/connection'),
  saveConnection: (payload: Record<string, unknown>) =>
    put<{ updated: string[]; connection: Connection }>('/api/connection', payload),
  testConnection: () => post<ConnectionTest>('/api/connection/test'),
  modelConfigs: () => request<ModelConfigsView>('/api/model-configs'),
  providers: (role?: ProviderRole) =>
    request<Provider[]>(`/api/providers${query({ role })}`),
  saveProvider: (role: ProviderRole, payload: Record<string, unknown>) =>
    put<{ id: number; api_key_set: boolean }>(`/api/providers/${role}`, payload),
  deleteProvider: (id: number) => del<{ deleted: number }>(`/api/providers/${id}`),
  probeProvider: (id: number) => post<ProviderProbe>(`/api/providers/${id}/probe`),
  akashaModels: (feature?: string) =>
    request<AkashaModelsView>(`/api/akasha-models${query({ feature })}`),
  saveAkashaModel: (payload: Record<string, unknown>) =>
    put<{ id: number; feature: string; label: string }>('/api/akasha-models', payload),
  deleteAkashaModel: (id: number) => del<{ deleted: number }>(`/api/akasha-models/${id}`),
  probeAkashaModel: (id: number) => post<ProviderProbe>(`/api/akasha-models/${id}/probe`),
  applyAkashaModel: (id: number) => post<{ applied: string }>(`/api/akasha-models/${id}/apply`),
  exportConfig: () => request<Record<string, unknown>>('/api/config/export'),
  importConfig: (data: Record<string, unknown>) =>
    post<{ connection: string[]; models: number }>(
      '/api/config/import',
      data,
    ),

  datasets: () => request<{ datasets: DatasetEntry[]; dataset_dir: string }>('/api/datasets'),
  importSpace: (name: string, file: File, overwrite = false) =>
    request<{ dataset: string; docs: number }>(
      `/api/datasets/import${query({ name, overwrite })}`,
      { method: 'POST', body: file, headers: { 'Content-Type': 'application/zip' } },
    ),
  deleteDataset: (name: string) =>
    del<{ deleted: number }>(`/api/datasets/${encodeURIComponent(name)}`),
  rawSamples: (
    name: string,
    params: { kind?: 'qa' | 'corpus'; q?: string; limit?: number; offset?: number } = {},
  ) => request<RawSamples>(`/api/datasets/${name}/raw${query(params)}`),
  samples: (name: string, params: { q?: string; limit?: number; offset?: number } = {}) =>
    request<SampleList>(`/api/datasets/${name}/samples${query(params)}`),
  sample: (name: string, sampleId: string) =>
    request<SampleDetail>(`/api/datasets/${name}/samples/${encodeURIComponent(sampleId)}`),
  corpus: (name: string, params: { q?: string; limit?: number; offset?: number } = {}) =>
    request<CorpusList>(`/api/datasets/${name}/corpus${query(params)}`),
  metrics: (datasets: string[] = []) =>
    request<MetricsView>(`/api/metrics${query({ datasets: datasets.join(',') })}`),

  compiles: () => request<{ compiles: CompileRun[] }>('/api/compiles'),
  compileEmbedding: (id: number) => request<CompileEmbedding>(`/api/compiles/${id}/embedding`),
  queryPreview: (id: number, question: string) =>
    post<QueryPreview>(`/api/compiles/${id}/query-preview`, { question }),
  compileDocs: (
    id: number,
    params: { dataset?: string; gold_only?: boolean; q?: string; limit?: number; offset?: number } = {},
  ) =>
    request<Paged & { docs: CompileDoc[]; imported: number }>(
      `/api/compiles/${id}/docs${query(params)}`,
    ),
  deleteCompile: (id: number) =>
    del<{
      deleted: number
      space_id: string | null
      cancelled_runs: number
      removed_bullmq_jobs: number
      note: string
    }>(`/api/compiles/${id}`),

  responses: (
    id: number,
    params: { dataset?: string; answer_mode?: string; q?: string; limit?: number; offset?: number } = {},
  ) => request<ResponseList>(`/api/queries/${id}/responses${query(params)}`),
  response: (id: number, sampleId: string) =>
    request<Record<string, unknown>>(
      `/api/queries/${id}/responses/${encodeURIComponent(sampleId)}`,
    ),
  retryFailedQuery: (id: number) => post<Task>(`/api/queries/${id}/retry-failed`),
  deleteQuery: (id: number) => del<{ deleted: number }>(`/api/queries/${id}`),

  evalRun: (id: number) => request<EvalDetail>(`/api/evals/${id}`),
  evalSamples: (
    id: number,
    params: { dataset?: string; answer_mode?: string; q?: string; limit?: number; offset?: number } = {},
  ) =>
    request<EvalSampleList>(`/api/evals/${id}/samples${query(params)}`),
  evalSample: (id: number, sampleId: string) =>
    request<EvalSampleDetail>(`/api/evals/${id}/samples/${encodeURIComponent(sampleId)}`),
  deleteEval: (id: number) => del<{ deleted: number }>(`/api/evals/${id}`),

  attribution: (id: number) => request<AttributionDetail>(`/api/attributions/${id}`),
  deleteAttribution: (id: number) => del<{ deleted: number }>(`/api/attributions/${id}`),
  lineage: (pageId: string, question = '') =>
    request<Lineage>(`/api/lineage/${encodeURIComponent(pageId)}${query({ question })}`),

  taskTree: () => request<TaskTree>('/api/task-tree'),
  task: (id: number, afterId = 0) =>
    request<TaskDetail>(`/api/tasks/${id}${query({ after_id: afterId })}`),
  startTask: (stage: string, args: Record<string, unknown>) =>
    post<Task>(`/api/tasks/${stage}`, args),
  startChain: (args: Record<string, unknown>) => post<Task>('/api/chain', args),
  pauseTask: (id: number) => post<Task>(`/api/tasks/${id}/pause`),
  resumeTask: (id: number) => post<Task>(`/api/tasks/${id}/resume`),
  deleteTask: (id: number) => del<{ deleted: number }>(`/api/tasks/${id}`),
  cleanupTasks: () => post<{ deleted: number }>('/api/tasks/cleanup/inactive'),
  audit: (stage?: string, limit = 200) =>
    request<TaskDetail['logs']>(`/api/audit${query({ stage, limit })}`),
}
