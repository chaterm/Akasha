import { useEffect, useState } from 'react'
import { api } from '../api'
import type {
  CompileRun,
  EvalDetail,
  EvalSampleDetail,
  EvalSampleList,
  MetricsView,
  QueryRun,
  Task,
} from '../types'
import {
  AnswerModeFilter,
  CleanupButton,
  ConfigPanel,
  Failed,
  Field,
  Loading,
  ModeTag,
  Pager,
  ProviderSelect,
  RecordNav,
  RecordSearch,
  RunCells,
  RunCountCells,
  Timing,
  duration,
  metric,
  percent,
  useAction,
  useAsync,
  usePagedRecordNavigation,
  usePoll,
  useProvider,
  useTaskWatch,
} from '../ui'

const FAMILIES = [
  { key: 'retrieval', label: '检索质量', hint: '需要 gold 标注' },
  { key: 'qa', label: '生成质量', hint: '与参考答案的字面相似度' },
  { key: 'attribution', label: '引用归因', hint: '引用与召回的差距' },
  { key: 'multihop', label: '多跳', hint: '图扩展的增量价值' },
  { key: 'judge', label: 'Judge 模型', hint: '逐条调用模型' },
] as const

type MetricFamily = (typeof FAMILIES)[number]['key']

function metricFamily(name: string, definitions: MetricsView['definitions']): string | null {
  const base = name.split('@', 1)[0]
  return definitions.find((definition) => definition.name === base)?.family ?? null
}

export function Evaluate({
  activeQuery,
  activeEval,
  onSelectQuery,
  onSelectEval,
  onOpenQuery,
  onAttribute,
  onOpenSettings,
}: {
  activeQuery: number | null
  activeEval: number | null
  onSelectQuery: (id: number) => void
  onSelectEval: (id: number | null) => void
  onOpenQuery: (compileId: number, queryId: number) => void
  onAttribute: (evalId: number) => void
  onOpenSettings: () => void
}) {
  const compiles = useAsync(() => api.compiles(), [])
  const tasks = useTaskWatch(compiles.reload)
  const cleanup = useAction<unknown>()

  const queries: QueryRun[] = (compiles.data?.compiles ?? []).flatMap((c: CompileRun) => c.queries)
  const done = queries.filter((q) => q.status === 'succeeded')
  const query = done.find((q) => q.id === activeQuery) ?? done[0] ?? null

  usePoll(
    queries.some((q) => q.evals.some((e) => e.status === 'running')),
    compiles.reload,
  )

  if (compiles.loading) return <Loading what="评测记录" />
  if (compiles.error) return <Failed error={compiles.error} />

  return (
    <>
      <h2>评测层</h2>

      {cleanup.error && <Failed error={cleanup.error} />}

      {done.length === 0 ? (
        <div className="note warn">还没有已完成的查询记录。</div>
      ) : (
        <ConfigPanel storageKey="evaluate" title="评测配置">
          <Field label="选择查询">
            <select
              value={query?.id ?? ''}
              onChange={(e) => {
                onSelectQuery(Number(e.target.value))
                onSelectEval(null)
              }}
            >
              {done.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.name}（#{run.id}）
                </option>
              ))}
            </select>
          </Field>
          {query && (
            <NewEval query={query} onOpenSettings={onOpenSettings} onStarted={tasks.watch} />
          )}
        </ConfigPanel>
      )}

      {query && query.evals.length > 0 && (
        <>
          <h3>评测记录</h3>
          <table className="records-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>评估模型</th>
                <th>状态</th>
                <th className="num">样本数</th>
                <th className="num">成功</th>
                <th className="num">并发</th>
                <th>k</th>
                <th className="num">指标数</th>
                <th>耗时</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {query.evals.map((run) => (
                <tr key={run.id} className={run.id === activeEval ? 'selected' : ''}>
                  <RunCells run={run} />
                  <RunCountCells run={run} />
                  <td className="num mono">{run.concurrency}</td>
                  <td className="small mono">{run.ks.join(', ')}</td>
                  <td className="num">{run.metrics.length}</td>
                  <td>
                    <Timing startedAt={run.created_at} finishedAt={run.finished_at} />
                  </td>
                  <td className="table-actions-cell">
                    <div className="table-actions">
                      <button
                        className="action small"
                        onClick={() => onSelectEval(run.id === activeEval ? null : run.id)}
                      >
                        {run.id === activeEval ? '收起' : '看结果'}
                      </button>
                      <button
                        className="action small"
                        disabled={run.status !== 'succeeded'}
                        onClick={() => onAttribute(run.id)}
                      >
                        去归因
                      </button>
                      <button
                        className="action small"
                        onClick={() => onOpenQuery(query.compile_id, run.query_id)}
                      >
                        回到查询
                      </button>
                      <CleanupButton
                        what={`评测 ${run.name}`}
                        detail="指标、汇总、judge 判决与它下面的归因都会从数据库删除。"
                        busy={cleanup.busy}
                        onConfirm={() =>
                          cleanup.run(async () => {
                            const result = await api.deleteEval(run.id)
                            onSelectEval(null)
                            compiles.reload()
                            return result
                          })
                        }
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {activeEval !== null && <Results key={activeEval} evalId={activeEval} />}
    </>
  )
}

function NewEval({
  query,
  onStarted,
  onOpenSettings,
}: {
  query: QueryRun
  onStarted: (task: Task) => void
  onOpenSettings: () => void
}) {
  const datasets = Object.keys(query.stats)
  const metrics = useAsync<MetricsView>(() => api.metrics(datasets), [datasets.join(',')])
  const judge = useProvider('judge')
  const [selected, setSelected] = useState<string[]>([])
  const [name, setName] = useState('')
  const [concurrency, setConcurrency] = useState(1)
  const start = useAction<unknown>()

  useEffect(() => {
    if (metrics.data && selected.length === 0) {
      const judgeMetrics = new Set(
        metrics.data.definitions.filter((d) => d.kind === 'judge').map((d) => d.name),
      )
      setSelected(metrics.data.computable_for_all.filter((n) => !judgeMetrics.has(n)))
    }
  }, [metrics.data])

  if (metrics.loading) return <Loading what="指标清单" />
  if (metrics.error) return <Failed error={metrics.error} />
  if (!metrics.data) return null

  const judgeSelected = selected.some(
    (name) => metrics.data?.definitions.find((d) => d.name === name)?.kind === 'judge',
  )
  const partial = new Set(
    metrics.data.computable_for_some.filter((n) => !metrics.data!.computable_for_all.includes(n)),
  )

  return (
    <div style={{ marginTop: 12 }}>
      {start.error && <Failed error={start.error} />}

      <h4>指标</h4>
      {FAMILIES.map(({ key, label, hint }) => {
        const group = metrics.data!.definitions.filter((d) => d.family === key)
        if (group.length === 0) return null
        const usable = group.filter((d) => metrics.data!.computable_for_some.includes(d.name))
        const allOn = usable.length > 0 && usable.every((d) => selected.includes(d.name))

        return (
          <div key={key} className="metric-family">
            <div className="spread">
              <span className="small">
                <strong>{label}</strong>
                <span className="muted"> · {hint}</span>
              </span>
              {usable.length > 0 && (
                <button
                  className="action small"
                  onClick={() =>
                    setSelected(
                      allOn
                        ? selected.filter((n) => !usable.some((d) => d.name === n))
                        : [...new Set([...selected, ...usable.map((d) => d.name)])],
                    )
                  }
                >
                  {allOn ? '全不选' : '全选'}
                </button>
              )}
            </div>
            <div className="metric-grid">
              {group.map((definition) => {
                const computable = metrics.data!.computable_for_some.includes(definition.name)
                return (
                  <label
                    key={definition.name}
                    className={`check${computable ? '' : ' unavailable'}`}
                    title={definition.description}
                  >
                    <input
                      type="checkbox"
                      disabled={!computable}
                      checked={selected.includes(definition.name)}
                      onChange={() =>
                        setSelected(
                          selected.includes(definition.name)
                            ? selected.filter((n) => n !== definition.name)
                            : [...selected, definition.name],
                        )
                      }
                    />
                    {definition.name}
                    {definition.kind === 'judge' && <span className="tag warn">模型</span>}
                    {partial.has(definition.name) && <span className="tag">部分</span>}
                  </label>
                )
              })}
            </div>
          </div>
        )
      })}

      <div className="row" style={{ marginTop: 10 }}>
        <Field label="评测名称" hint="留空自动生成">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="自动" />
        </Field>
        {judgeSelected && (
          <>
            <ProviderSelect label="评估模型 Judge" provider={judge} />
            <Field label="并发" hint="Judge 调用并发数">
              <input type="number" min={1} max={16} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
            </Field>
          </>
        )}
      </div>

      {judgeSelected && judge.list.length === 0 && (
        <div className="note warn">
          勾了 Judge 指标但还没配 judge 模型端点。
          <button className="action small" style={{ marginLeft: 8 }} onClick={onOpenSettings}>
            去配置
          </button>
        </div>
      )}

      <div className="panel-actions">
        <button
          className="action primary"
          disabled={start.busy || selected.length === 0}
          onClick={() =>
            start.run(async () => {
              const task = await api.startTask('evaluate', {
                query_id: query.id,
                metrics: selected,
                ...(name.trim() ? { name: name.trim() } : {}),
                ...(judge.id === null ? {} : { judge_provider_id: judge.id }),
                ...(judgeSelected ? { concurrency } : {}),
              })
              onStarted(task)
              return task
            })
          }
        >
          {start.busy ? '启动中…' : '开始评测'}
        </button>
        <span className="small muted">已选 {selected.length} 个指标</span>
      </div>
    </div>
  )
}

function Results({ evalId }: { evalId: number }) {
  const detail = useAsync<EvalDetail>(() => api.evalRun(evalId), [evalId])
  const registry = useAsync<MetricsView>(() => api.metrics(), [])
  const [dataset, setDataset] = useState<string>('')
  const [chosenFamily, setFamily] = useState<MetricFamily | null>(null)

  if (detail.loading) return <Loading what="评测结果" />
  if (detail.error) return <Failed error={detail.error} />
  if (!detail.data) return null
  if (registry.loading) return <Loading what="指标分组" />
  if (registry.error) return <Failed error={registry.error} />
  if (!registry.data) return null

  const data = detail.data
  const definitions = registry.data.definitions
  const metricNames = Array.from(
    new Set(
      data.datasets.flatMap((entry) =>
        Object.values(entry.scopes).flatMap((scope) => Object.keys(scope)),
      ),
    ),
  )
  const availableFamilies = FAMILIES.filter(({ key }) =>
    metricNames.some((name) => metricFamily(name, definitions) === key),
  )
  const family = availableFamilies.some(({ key }) => key === chosenFamily)
    ? chosenFamily
    : availableFamilies[0]?.key ?? null
  const shown = dataset ? data.datasets.filter((d) => d.dataset === dataset) : data.datasets

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="row tight" style={{ marginBottom: 8 }}>
        <select value={dataset} onChange={(e) => setDataset(e.target.value)}>
          <option value="">全部数据集</option>
          {data.datasets.map((entry) => (
            <option key={entry.dataset} value={entry.dataset}>
              {entry.dataset}
            </option>
          ))}
        </select>
      </div>

      {availableFamilies.length > 0 && (
        <div className="metric-family-filter">
          <span className="small muted">指标组</span>
          {availableFamilies.map(({ key, label, hint }) => (
            <button
              key={key}
              className={`action small${family === key ? ' primary' : ''}`}
              title={hint}
              onClick={() => setFamily(key)}
            >
              {label}
              <span className="muted">
                {' '}
                {metricNames.filter(
                  (name) => metricFamily(name, definitions) === key,
                ).length}
              </span>
            </button>
          ))}
        </div>
      )}

      {data.judge.total > 0 && (
        <div className={`note${data.judge.failure_rate > 0.1 ? ' bad' : ' plain'}`}>
          <strong>Judge 调用 {data.judge.total} 次</strong> · 已评分 {data.judge.scored}，失败率{' '}
          {percent(data.judge.failure_rate)}
          {data.judge.latency_mean !== null && (
            <> · 平均 {duration(data.judge.latency_mean)}/条</>
          )}
        </div>
      )}

      {shown.map((entry) => (
        <div key={entry.dataset} style={{ marginBottom: 18 }}>
          {entry.http_failures > 0 && (
            <span className="tag bad">HTTP 失败 {entry.http_failures}</span>
          )}

          <p className="small muted">
            回答模式：
            {Object.entries(entry.answer_modes).map(([mode, share]) => (
              <span key={mode} style={{ marginLeft: 6 }}>
                <ModeTag mode={mode} /> {percent(share)}
              </span>
            ))}
          </p>

          <ScopeTable
            scopes={entry.scopes}
            family={family}
            definitions={definitions}
          />
        </div>
      ))}

      <SampleResults
        key={dataset}
        evalId={evalId}
        dataset={dataset}
        family={family}
        definitions={definitions}
      />
    </div>
  )
}

function SampleResults({
  evalId,
  dataset,
  family,
  definitions,
}: {
  evalId: number
  dataset: string
  family: MetricFamily | null
  definitions: MetricsView['definitions']
}) {
  const [offset, setOffset] = useState(0)
  const [openSample, setOpenSample] = useState<string | null>(null)
  const [term, setTerm] = useState('')
  const [q, setQ] = useState('')
  const [mode, setMode] = useState('')
  const limit = 5
  const samples = useAsync<EvalSampleList>(
    () =>
      api.evalSamples(evalId, {
        dataset: dataset || undefined,
        answer_mode: mode || undefined,
        q,
        limit,
        offset,
      }),
    [evalId, dataset, mode, q, offset],
  )
  const nav = usePagedRecordNavigation({
    items: samples.data?.samples ?? [],
    total: samples.data?.total ?? 0,
    responseOffset: samples.data?.offset ?? offset,
    offset,
    limit,
    selectedKey: openSample,
    itemKey: (sample) => sample.sample_id,
    onSelect: (sample) => setOpenSample(sample.sample_id),
    onOffsetChange: setOffset,
  })

  if (openSample) {
    return (
      <div style={{ marginTop: 18 }}>
        <div className="spread">
          <h4 style={{ margin: 0 }}>样本 {openSample}</h4>
          <RecordNav
            hasPrevious={nav.hasPrevious}
            hasNext={nav.hasNext}
            onPrevious={nav.previous}
            onNext={nav.next}
            onBack={() => setOpenSample(null)}
            backLabel="返回样本列表"
            position={nav.position}
            total={samples.data?.total ?? 0}
            busy={samples.loading || nav.navigating}
          />
        </div>
        <EvalSampleView key={openSample} evalId={evalId} sampleId={openSample} />
      </div>
    )
  }

  if (samples.loading) return <Loading what="评测样本" />
  if (samples.error) return <Failed error={samples.error} />
  if (!samples.data) return null

  return (
    <div style={{ marginTop: 18 }}>
      <div className="record-filters">
        <AnswerModeFilter
          counts={samples.data.count_by_answer_mode}
          value={mode}
          onChange={(value) => {
            setMode(value)
            setOffset(0)
            setOpenSample(null)
          }}
        />
        <RecordSearch
          placeholder="搜索 sample_id、问题或系统答案"
          value={term}
          onChange={setTerm}
          onSearch={(value) => {
            setQ(value)
            setOffset(0)
          }}
        />
      </div>
      {samples.data.total === 0 ? (
        <p className="small muted">没有匹配的样本。</p>
      ) : (
        <table className="eval-samples-table">
          <thead>
            <tr>
              <th>sample_id</th>
              <th>问题</th>
              <th>答案模式</th>
              <th>指标</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {samples.data.samples.map((sample) => (
              <tr key={sample.sample_id}>
                <td className="mono small">{sample.sample_id}</td>
                <td className="small">{sample.question}</td>
                <td><ModeTag mode={sample.answer_mode} /></td>
                <td>
                  <MetricTags metrics={sample.metrics} family={family} definitions={definitions} />
                </td>
                <td>
                  <button className="action small" onClick={() => setOpenSample(sample.sample_id)}>
                    查看详情
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {samples.data.total > 0 && (
        <Pager
          total={samples.data.total}
          offset={offset}
          limit={limit}
          onChange={setOffset}
        />
      )}
    </div>
  )
}

function EvalSampleView({ evalId, sampleId }: { evalId: number; sampleId: string }) {
  const detail = useAsync<EvalSampleDetail>(() => api.evalSample(evalId, sampleId), [evalId, sampleId])
  if (detail.loading) return <Loading what="样本明细" />
  if (detail.error) return <Failed error={detail.error} />
  if (!detail.data) return null
  return (
    <div className="panel flat" style={{ marginTop: 10 }}>
      <h4>响应概览</h4>
      <dl className="kv">
        <dt>问题</dt><dd>{text(detail.data.detail.question)}</dd>
        <dt>参考答案</dt>
        <dd>{strings(detail.data.detail.reference_answers).join(' / ') || '—'}</dd>
        <dt>回答模式</dt><dd><ModeTag mode={detail.data.answer_mode} /></dd>
        <dt>HTTP 状态</dt>
        <dd><span className={`tag ${detail.data.http_status >= 200 && detail.data.http_status < 300 ? 'ok' : 'bad'}`}>{detail.data.http_status}</span></dd>
        <dt>系统答案</dt><dd>{detail.data.answer || '—'}</dd>
      </dl>

      <h4>逐样本指标</h4>
      <MetricTags metrics={detail.data.metrics} />

      <p className="small muted">检索上下文、引用证据和 Judge 明细请在归因层查看。</p>
    </div>
  )
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function text(value: unknown, fallback = '—'): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function MetricTags({
  metrics,
  family,
  definitions = [],
}: {
  metrics: Record<string, number>
  family?: MetricFamily | null
  definitions?: MetricsView['definitions']
}) {
  const entries = Object.entries(metrics).filter(
    ([name]) => !family || metricFamily(name, definitions) === family,
  )
  if (entries.length === 0) return <span className="small muted">没有指标值。</span>
  return (
    <div className="metric-tags">
      {entries.map(([name, value]) => (
        <span key={name} className="tag">{name} · {Number(value).toFixed(4)}</span>
      ))}
    </div>
  )
}

function ScopeTable({
  scopes,
  family,
  definitions,
}: {
  scopes: Record<string, Record<string, number>>
  family: MetricFamily | null
  definitions: MetricsView['definitions']
}) {
  const names = Array.from(
    new Set(Object.values(scopes).flatMap((entry) => Object.keys(entry))),
  )
    .filter((name) => !family || metricFamily(name, definitions) === family)
    .sort()
  if (names.length === 0) return <p className="small muted">没有指标值。</p>

  return (
    <table>
      <thead>
        <tr>
          <th>指标</th>
          <th className="num">全样本</th>
          <th className="num">仅 knowledge</th>
          <th className="num">judge</th>
        </tr>
      </thead>
      <tbody>
        {names.map((name) => (
          <tr key={name}>
            <td className="mono small">{name}</td>
            <td className="num">{metric(scopes.overall ?? {}, name)}</td>
            <td className="num">{metric(scopes.knowledge_only ?? {}, name)}</td>
            <td className="num">{metric(scopes.judge ?? {}, name)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
