import { useState } from 'react'
import { api } from '../api'
import type { CompileDoc, CompileRun, DatasetEntry, QueryPreview, Task } from '../types'
import {
  CleanupButton,
  ConfigPanel,
  DatasetPicker,
  Failed,
  Field,
  Loading,
  Pager,
  Pass,
  RecordNav,
  RecordSearch,
  StatusTag,
  Timing,
  num,
  useAction,
  useAsync,
  usePagedRecordNavigation,
  usePoll,
  useTaskWatch,
} from '../ui'

function todaySeed(): number {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return Number(`${now.getFullYear()}${month}${day}`)
}

export function Compile({
  activeCompile,
  onSelect,
  onOpenQuery,
}: {
  activeCompile: number | null
  onSelect: (id: number) => void
  onOpenQuery: (id: number) => void
}) {
  const compiles = useAsync(() => api.compiles(), [])
  const datasets = useAsync(() => api.datasets(), [])
  const cleanup = useAction<unknown>()
  const tasks = useTaskWatch(compiles.reload)

  usePoll(
    (compiles.data?.compiles ?? []).some((c) => c.status === 'running'),
    compiles.reload,
  )

  if (compiles.loading || datasets.loading) return <Loading what="编译记录" />
  if (compiles.error) return <Failed error={compiles.error} />
  if (datasets.error) return <Failed error={datasets.error} />
  if (!compiles.data || !datasets.data) return null

  const normalized = datasets.data.datasets.filter((d) => d.normalized)
  const selected = compiles.data.compiles.find((c) => c.id === activeCompile) ?? null

  return (
    <>
      <h2>编译层</h2>

      {cleanup.error && <Failed error={cleanup.error} />}

      <NewCompile datasets={normalized} onStarted={tasks.watch} />

      <h3>编译记录</h3>
      {compiles.data.compiles.length === 0 && <p className="muted">还没有编译记录。</p>}
      {compiles.data.compiles.length > 0 && (
        <table className="records-table">
          <thead>
            <tr>
              <th>run_id</th>
              <th>数据集</th>
              <th>编译模型</th>
              <th>状态</th>
              <th>质量闸门</th>
              <th className="num">语料</th>
              <th className="num">已导入</th>
              <th className="num">成功</th>
              <th>耗时</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {compiles.data.compiles.map((run) => {
              const stats = Object.values(run.stats)
              const docs = stats.reduce((sum, s) => sum + (s.docs ?? 0), 0)
              const imported = stats.reduce((sum, s) => sum + (s.imported ?? 0), 0)
              return (
                <tr key={run.id} className={run.id === activeCompile ? 'selected' : ''}>
                  <td className="mono small">
                    {run.run_id} <span className="muted">#{run.id}</span>
                  </td>
                  <td className="small">{run.datasets.join(', ')}</td>
                  <td className="small">{run.model_label ?? '—'}</td>
                  <td>
                    <StatusTag status={run.status} />
                  </td>
                  <td>{run.quality ? <Pass ok={run.quality.passed} /> : <span className="tag">未执行</span>}</td>
                  <td className="num">{docs}</td>
                  <td className="num">{imported}</td>
                  <td className="num" title="由远端编译 Run 的逐页进度统计">
                    {num(run.compiled_pages)}
                  </td>
                  <td>
                    <Timing
                      startedAt={run.created_at}
                      finishedAt={run.finished_at}
                      latencyMs={run.pace?.per_page_ms}
                      perLabel="篇"
                    />
                  </td>
                  <td className="table-actions-cell">
                    <div className="table-actions">
                      <button className="action small" onClick={() => onSelect(run.id)}>
                        {run.id === activeCompile ? '已选中' : '查看'}
                      </button>
                      <button
                        className="action small"
                        disabled={!run.readiness.ready}
                        onClick={() => onOpenQuery(run.id)}
                      >
                        去查询
                      </button>
                      <CleanupButton
                        what={`编译 ${run.run_id}`}
                        detail="子集、语料映射，以及它下面的查询、评测、归因都会从数据库删除。Akasha 那边的空间不会被删。"
                        busy={cleanup.busy}
                        onConfirm={() =>
                          cleanup.run(async () => {
                            const result = await api.deleteCompile(run.id)
                            compiles.reload()
                            return result
                          })
                        }
                      />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {selected && <CompileDetail run={selected} />}
    </>
  )
}

function NewCompile({
  datasets,
  onStarted,
}: {
  datasets: DatasetEntry[]
  onStarted: (task: Task) => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [runId, setRunId] = useState('')
  const [fullQa, setFullQa] = useState(true)
  const [qaLimit, setQaLimit] = useState(20)
  const [seed, setSeed] = useState(todaySeed)
  const [fullCorpus, setFullCorpus] = useState(true)
  const [ratio, setRatio] = useState(1)
  const [importConcurrency, setImportConcurrency] = useState(10)
  const [scheduleAt, setScheduleAt] = useState('')
  const start = useAction<unknown>()
  const selectedQaMax = Math.max(
    0,
    ...selected.map((name) => datasets.find((dataset) => dataset.name === name)?.qa_rows ?? 0),
  )
  const effectiveQaLimit = fullQa ? selectedQaMax : qaLimit
  return (
    <ConfigPanel storageKey="compile" title="新建编译">
      {datasets.length === 0 && (
        <div className="note warn">还没有归一化过的数据集，请先在「归一化」页处理。</div>
      )}
      {start.error && <Failed error={start.error} />}

      <DatasetPicker
        all={datasets.map((dataset) => dataset.name)}
        selected={selected}
        onChange={setSelected}
      />

      <div className="note small" style={{ marginTop: 10 }}>
        编译使用 Akasha 当前远端生效的 compiler、embedding 和 image 配置。
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <Field label="run_id" hint="留空自动生成；填已有续跑">
          <input value={runId} onChange={(e) => setRunId(e.target.value)} placeholder="自动" />
        </Field>
        <Field label="QA 范围">
          <select
            value={fullQa ? 'all' : 'sampled'}
            onChange={(e) => setFullQa(e.target.value === 'all')}
          >
            <option value="all">全量</option>
            <option value="sampled">抽样</option>
          </select>
        </Field>
        {!fullQa && (
          <Field label="每组抽取数">
            <input
              type="number"
              min={1}
              value={qaLimit}
              onChange={(e) => setQaLimit(Number(e.target.value))}
            />
          </Field>
        )}
        <Field label="随机种子">
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} />
        </Field>
        <Field label="语料范围">
          <select
            value={fullCorpus ? 'all' : 'sampled'}
            onChange={(e) => setFullCorpus(e.target.value === 'all')}
          >
            <option value="all">全量</option>
            <option value="sampled">Gold + 负样本</option>
          </select>
        </Field>
        {!fullCorpus && (
          <Field label="负样本比例" hint="每篇 gold 配几篇">
            <input
              type="number"
              step={0.5}
              min={0}
              value={ratio}
              onChange={(e) => setRatio(Number(e.target.value))}
            />
          </Field>
        )}
        <Field label="导入并发" hint="同时上传的文档数">
          <input
            type="number"
            min={1}
            max={16}
            value={importConcurrency}
            onChange={(e) => setImportConcurrency(Number(e.target.value))}
          />
        </Field>
        <Field label="定时启动" hint="留空则立即开始">
          <input
            type="datetime-local"
            value={scheduleAt}
            onChange={(e) => setScheduleAt(e.target.value)}
          />
        </Field>
      </div>

      <div className="panel-actions">
        <button
          className="action primary"
          disabled={
            start.busy ||
            selected.length === 0 ||
            effectiveQaLimit < 1 ||
            importConcurrency < 1 ||
            importConcurrency > 16
          }
          onClick={() =>
            start.run(async () => {
              const task = await api.startTask('compile', {
                datasets: selected,
                qa_limit: effectiveQaLimit,
                seed,
                full_corpus: fullCorpus,
                import_concurrency: importConcurrency,
                ...(fullCorpus ? {} : { negatives_ratio: ratio }),
                ...(runId.trim() ? { run_id: runId.trim() } : {}),
                ...(scheduleAt ? { schedule_at: scheduleAt } : {}),
              })
              onStarted(task)
              return task
            })
          }
        >
          {start.busy ? '启动中…' : '开始编译'}
        </button>
      </div>
    </ConfigPanel>
  )
}

function CompileDetail({ run }: { run: CompileRun }) {
  const [dataset, setDataset] = useState<string>('')
  const [goldOnly, setGoldOnly] = useState(false)
  const [offset, setOffset] = useState(0)
  const [openDoc, setOpenDoc] = useState<{ key: string; pageId: string | null; title: string } | null>(null)
  const [term, setTerm] = useState('')
  const [q, setQ] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const limit = 5

  const docs = useAsync(
    () =>
      api.compileDocs(run.id, {
        dataset: dataset || undefined,
        gold_only: goldOnly,
        q,
        limit,
        offset,
      }),
    [run.id, dataset, goldOnly, q, limit, offset],
  )
  const selectDoc = (doc: CompileDoc) =>
    setOpenDoc({
      key: `${doc.dataset}/${doc.doc_id}`,
      pageId: doc.page_id,
      title: doc.title || doc.doc_id,
    })
  const nav = usePagedRecordNavigation({
    items: docs.data?.docs ?? [],
    total: docs.data?.total ?? 0,
    responseOffset: docs.data?.offset ?? offset,
    offset,
    limit,
    selectedKey: openDoc?.key ?? null,
    itemKey: (doc) => `${doc.dataset}/${doc.doc_id}`,
    onSelect: selectDoc,
    onOffsetChange: setOffset,
  })

  if (openDoc) {
    return (
      <div className="panel" style={{ marginTop: 14 }}>
        <div className="spread">
          <h3 style={{ margin: 0 }}>编译变化</h3>
          <RecordNav
            hasPrevious={nav.hasPrevious}
            hasNext={nav.hasNext}
            onPrevious={nav.previous}
            onNext={nav.next}
            onBack={() => setOpenDoc(null)}
            backLabel="返回文档列表"
            position={nav.position}
            total={docs.data?.total ?? 0}
            busy={docs.loading || nav.navigating}
          />
        </div>
        {openDoc.pageId ? (
          <LineageView pageId={openDoc.pageId} title={openDoc.title} />
        ) : (
          <div className="note warn">这篇文档尚未导入，没有可查看的编译变化。</div>
        )}
      </div>
    )
  }

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="panel-head">
        <div>
          <h3 style={{ margin: 0 }}>编译详情</h3>
          <div className="small muted">
            {run.run_id} · {run.space_name || run.space_id || '尚未创建空间'}
          </div>
        </div>
        <button
          className="action primary"
          disabled={!run.readiness.ready}
          title={run.readiness.ready ? '输入问题并观察这次编译的单条查询结果' : run.readiness.reasons.join('；')}
          onClick={() => setPreviewOpen(!previewOpen)}
        >
          {previewOpen ? '收起单条试查' : '单条试查'}
        </button>
      </div>

      {previewOpen && <SingleQueryPanel compile={run} />}

      {run.readiness.warnings.length > 0 && (
        <div className="note warn">
          <strong>这次编译可用于查询，但结果不完整。</strong>
          <ul>
            {run.readiness.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {run.quality && (
        <p className="small muted">
          质量闸门：
          {Object.entries(run.quality.gates).map(([name, value]) => (
            <span key={name} className={`tag ${value === 0 ? 'ok' : 'bad'}`} style={{ marginLeft: 4 }}>
              {name}={value ?? 'n/a'}
            </span>
          ))}
        </p>
      )}

      <div className="record-filters">
        <select
          value={dataset}
          onChange={(e) => {
            setDataset(e.target.value)
            setOffset(0)
          }}
        >
          <option value="">全部数据集</option>
          {run.datasets.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={goldOnly}
            onChange={() => {
              setGoldOnly(!goldOnly)
              setOffset(0)
            }}
          />
          只看 gold
        </label>
        <RecordSearch
          placeholder="搜索 doc_id、文档标题或 page_id"
          value={term}
          onChange={setTerm}
          onSearch={(value) => {
            setQ(value)
            setOffset(0)
            setOpenDoc(null)
          }}
        />
      </div>

      {docs.loading && <Loading what="文档" />}
      {docs.error && <Failed error={docs.error} />}
      {docs.data && (
        <>
          <table>
            <thead>
              <tr>
                <th>doc_id</th>
                <th>数据集</th>
                <th>文档标题</th>
                <th>gold</th>
                <th>page_id</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {docs.data.docs.map((doc) => (
                <tr key={`${doc.dataset}/${doc.doc_id}`}>
                  <td className="mono small">{doc.doc_id}</td>
                  <td className="small muted">{doc.dataset}</td>
                  <td className="small">{doc.title || '—'}</td>
                  <td>{doc.is_gold ? <span className="tag ok">gold</span> : '—'}</td>
                  <td className="mono small muted truncate">
                    {doc.page_id ?? <span className="tag bad">未导入</span>}
                  </td>
                  <td>
                    {doc.page_id && (
                      <button
                        className="action small"
                        onClick={() => selectDoc(doc)}
                      >
                        编译变化
                      </button>
                    )}
                    {doc.error && (
                      <span className="small" style={{ color: 'var(--bad)' }} title={doc.error}>
                        导入失败
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager total={docs.data.total} offset={offset} limit={limit} onChange={setOffset} />
        </>
      )}

    </div>
  )
}

function SingleQueryPanel({ compile }: { compile: CompileRun }) {
  const [question, setQuestion] = useState('')
  const preview = useAction<QueryPreview>()
  const submit = () => {
    const value = question.trim()
    if (!value || preview.busy) return
    preview.run(() => api.queryPreview(compile.id, value))
  }

  return (
    <div style={{ margin: '12px 0', padding: '12px 0', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
      <div className="small muted" style={{ marginBottom: 6 }}>
        仅观察这次编译的单条查询，不会生成批量查询记录。
      </div>
      <label className="field" style={{ display: 'block' }}>
        <span>问题</span>
        <textarea
          rows={3}
          style={{ width: '100%', resize: 'vertical' }}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submit()
          }}
          placeholder="输入一个问题"
        />
      </label>
      <div className="panel-actions">
        <button
          className="action primary"
          disabled={preview.busy || !question.trim()}
          onClick={submit}
        >
          {preview.busy ? '查询中…' : '运行单条试查'}
        </button>
      </div>
      {preview.error && <Failed error={preview.error} />}
      {preview.result && <QueryPreviewResult result={preview.result} />}
    </div>
  )
}

function QueryPreviewResult({ result }: { result: QueryPreview }) {
  const ok = result.http_status >= 200 && result.http_status < 300 && !result.error
  const evidence = result.snippets.length > 0 ? result.snippets : result.retrieved_sources
  return (
    <div style={{ marginTop: 12 }}>
      <div className="row tight">
        <span className={`tag ${ok ? 'ok' : 'bad'}`}>HTTP {result.http_status}</span>
        {result.answer_mode && <span className="tag accent">{result.answer_mode}</span>}
        <span className="small muted mono">{result.latency_ms}ms</span>
      </div>
      {result.error && <div className="note bad">{result.error}</div>}
      {result.answer !== null && result.answer !== undefined && (
        <>
          <h4>答案</h4>
          <pre className="block">{previewValue(result.answer)}</pre>
        </>
      )}
      <div className="side-by-side" style={{ marginTop: 10 }}>
        <div>
          <h4>召回片段（{evidence.length}）</h4>
          {evidence.length > 0 ? (
            <div className="stack">
              {evidence.map((entry, index) => (
                <pre className="block" key={index}>{previewEntry(entry)}</pre>
              ))}
            </div>
          ) : <p className="small muted">没有返回召回片段。</p>}
        </div>
        <div>
          <h4>引用（{result.citations.length}）</h4>
          {result.citations.length > 0 ? (
            <div className="stack">
              {result.citations.map((entry, index) => (
                <pre className="block" key={index}>{previewEntry(entry)}</pre>
              ))}
            </div>
          ) : <p className="small muted">没有返回引用。</p>}
        </div>
      </div>
      <details style={{ marginTop: 10 }}>
        <summary className="small muted">查看原始响应</summary>
        <pre className="block" style={{ marginTop: 6 }}>{previewValue(result.response)}</pre>
      </details>
    </div>
  )
}

function previewEntry(entry: Record<string, unknown>): string {
  const title = [entry.title, entry.sourcePageId, entry.knowledgePageId]
    .find((value): value is string => typeof value === 'string' && value.length > 0)
  const text = entry.text
  if (title && typeof text === 'string' && text) return `${title}\n${text}`
  return previewValue(entry)
}

function previewValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function LineageView({
  pageId,
  question = '',
  title,
}: {
  pageId: string
  question?: string
  title?: string
}) {
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const { data, error, loading } = useAsync(
    () => api.lineage(pageId, question),
    [pageId, question],
  )

  if (loading) return <Loading what="编译链路" />
  if (error) return <Failed error={error} />
  if (!data) return null

  const selectedArtifact = data.artifacts.find((artifact) => artifact.id === selectedArtifactId)
  const compiledChunks = selectedArtifactId
    ? data.chunks.filter((chunk) => chunk.knowledge_page_id === selectedArtifactId)
    : data.chunks

  return (
    <div className="panel flat" style={{ marginTop: 12 }}>
      <div className={title ? 'small muted' : 'note plain small'}>
        {title && <><strong>{title}</strong> · </>}
        {selectedArtifact && <>当前 artifact：<strong>{selectedArtifact.title || selectedArtifact.id}</strong> · </>}
        编译扩写比 {data.diff.expansion_ratio?.toFixed(2) ?? '—'}，
        实词留存 {data.diff.retention ? `${(data.diff.retention * 100).toFixed(1)}%` : '—'}，
        编译丢掉的实词 {data.diff.dropped_total} 个。
      </div>

      {data.question_terms_lost.length > 0 && (
        <div className="note bad">
          <strong>{data.verdict}</strong>
          <div style={{ marginTop: 4 }}>
            {data.question_terms_lost.map((term) => (
              <span key={term} className="chip lost">
                {term}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="side-by-side">
        <div>
          <h4>原文（{data.source.chunk_count} 块，不参与召回）</h4>
          <ChunkPager
            items={data.source_chunks.map((c) => ({ text: c.text }))}
            empty="（无原文块）"
          />
        </div>
        <div>
          <h4>
            编译产物（{data.compiled.chunk_count} 块 / {data.compiled.artifact_count} 个 artifact，被检索的文本）
          </h4>
          {data.artifacts.length > 0 && (
            <div className="row tight" style={{ marginBottom: 6 }}>
              {data.artifacts.map((a, i) => (
                <button
                  key={a.id || i}
                  className={`tag accent${selectedArtifactId === a.id ? ' selected' : ''}`}
                  type="button"
                  onClick={() => setSelectedArtifactId(a.id)}
                  title="切换到该编译产物"
                >
                  {a.title || '（无标题）'}
                  {a.page_type && <span className="muted"> · {a.page_type}</span>}
                </button>
              ))}
              {selectedArtifactId && (
                <button className="tag" type="button" onClick={() => setSelectedArtifactId(null)}>
                  显示全部
                </button>
              )}
            </div>
          )}
          <ChunkPager
            items={compiledChunks.map((c) => ({
              text: c.text,
              label: [c.title, c.chunk_role].filter(Boolean).join(' · '),
            }))}
            empty="（无编译块）"
          />
        </div>
      </div>

      {data.diff.dropped.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {data.diff.dropped.map((term) => (
            <span key={term} className="chip dropped">
              {term}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function ChunkPager({ items, empty }: { items: { text: string; label?: string }[]; empty: string }) {
  const [i, setI] = useState(0)
  if (items.length === 0) return <p className="small muted">{empty}</p>
  const idx = Math.min(i, items.length - 1)
  const item = items[idx]!

  return (
    <>
      {item.label && <div className="small muted mono" style={{ marginBottom: 4 }}>{item.label}</div>}
      <pre className="block tall">{item.text || '（空）'}</pre>
      {items.length > 1 && (
        <div className="row tight" style={{ marginTop: 6 }}>
          <button className="action small" disabled={idx === 0} onClick={() => setI(idx - 1)}>
            上一块
          </button>
          <span className="small muted">
            {idx + 1} / {items.length}
          </span>
          <button
            className="action small"
            disabled={idx >= items.length - 1}
            onClick={() => setI(idx + 1)}
          >
            下一块
          </button>
        </div>
      )}
    </>
  )
}
