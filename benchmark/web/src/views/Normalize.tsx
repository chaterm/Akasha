import { useState } from 'react'
import { api } from '../api'
import {
  CleanupButton,
  DatasetPicker,
  Failed,
  Loading,
  Pager,
  RecordNav,
  RecordSearch,
  num,
  useAction,
  useAsync,
  usePagedRecordNavigation,
} from '../ui'

export function Normalize({ onOpenTasks }: { onOpenTasks: () => void }) {
  const { data, error, loading, reload } = useAsync(() => api.datasets(), [])
  const [selected, setSelected] = useState<string[]>([])
  const [open, setOpen] = useState<{ dataset: string; kind: 'samples' | 'corpus' } | null>(null)
  const [reopened, setReopened] = useState(false)
  const start = useAction<unknown>()
  const cleanup = useAction<unknown>()

  if (loading) return <Loading what="归一化状态" />
  if (error) return <Failed error={error} />
  if (!data) return null

  const ready = data.datasets.filter((d) => d.files_ready)
  const targets = selected.length ? selected : ready.map((d) => d.name)

  const allDone = ready.length > 0 && ready.every((d) => d.normalized)

  return (
    <>
      <div className="spread">
        <h2>归一化</h2>
        <div className="row tight">
          {allDone && !reopened && (
            <button className="action small" onClick={() => setReopened(true)}>
              重新归一化
            </button>
          )}
          <button className="action small" onClick={reload}>
            刷新
          </button>
        </div>
      </div>

      {start.error && <Failed error={start.error} />}
      {cleanup.error && <Failed error={cleanup.error} />}

      {(!allDone || reopened) && (
        <div className="panel">
          <div className="row">
            <DatasetPicker
              all={ready.map((d) => d.name)}
              selected={selected}
              onChange={setSelected}
            />
            <button
              className="action primary"
              disabled={start.busy || targets.length === 0}
              onClick={() =>
                start.run(async () => {
                  const task = await api.startTask('normalize', { datasets: targets })
                  onOpenTasks()
                  return task
                })
              }
            >
              {start.busy ? '启动中…' : `归一化并验收（${targets.length} 组）`}
            </button>
            {reopened && (
              <button className="action small" onClick={() => setReopened(false)}>
                收起
              </button>
            )}
          </div>
          {ready.length < data.datasets.length && (
            <div className="note warn">
              有 {data.datasets.length - ready.length} 组的原始文件还没就绪，请先在「数据集」页下载或生成样本。
            </div>
          )}
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>数据集</th>
            <th>适配器</th>
            <th>拥有的标注</th>
            <th>身份规则</th>
            <th>状态</th>
            <th className="num">样本</th>
            <th className="num">语料</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.datasets.map((entry) => (
            <tr key={entry.name} className={open?.dataset === entry.name ? 'selected' : ''}>
              <td>{entry.name}</td>
              <td className="small mono muted">{entry.adapter}</td>
              <td>
                {entry.provides.map((d) => (
                  <span key={d} className="tag ok">
                    {d}
                  </span>
                ))}
                {entry.provides.length === 0 && <span className="tag">无</span>}
              </td>
              <td className="small mono muted">
                {Object.entries(entry.identity_rules)
                  .map(([key, rule]) => `${key}=${rule}`)
                  .join(' ')}
              </td>
              <td>
                {entry.normalized ? (
                  <span className="tag ok" title={entry.normalized_at ?? ''}>
                    已入库
                  </span>
                ) : (
                  <span className="tag">未入库</span>
                )}
              </td>
              <td className="num">{num(entry.qa_rows)}</td>
              <td className="num">{num(entry.corpus_rows)}</td>
              <td>
                <div className="row tight">
                  {(['samples', 'corpus'] as const).map((kind) => {
                    const active = open?.dataset === entry.name && open.kind === kind
                    return (
                      <button
                        key={kind}
                        className={`action small${active ? ' primary' : ''}`}
                        disabled={!entry.normalized}
                        onClick={() =>
                          setOpen(active ? null : { dataset: entry.name, kind })
                        }
                      >
                        {kind === 'samples' ? '样本' : '语料'}
                      </button>
                    )
                  })}
                  {entry.normalized && (
                    <CleanupButton
                      what={`${entry.name} 的归一化产物`}
                      detail="样本与语料会从数据库删除，原始文件保留。已被编译层引用时会拒绝。"
                      busy={cleanup.busy}
                      onConfirm={() =>
                        cleanup.run(async () => {
                          const result = await api.deleteDataset(entry.name)
                          setOpen((c) => (c?.dataset === entry.name ? null : c))
                          reload()
                          return result
                        })
                      }
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && (
        <Browser key={`${open.dataset}:${open.kind}`} dataset={open.dataset} tab={open.kind} />
      )}
    </>
  )
}

function Browser({ dataset, tab }: { dataset: string; tab: 'samples' | 'corpus' }) {
  const [offset, setOffset] = useState(0)
  const [term, setTerm] = useState('')
  const [q, setQ] = useState('')
  const [sampleId, setSampleId] = useState<string | null>(null)
  const limit = tab === 'samples' ? 5 : 1

  const samples = useAsync(
    () => (tab === 'samples' ? api.samples(dataset, { q, limit, offset }) : Promise.resolve(null)),
    [dataset, tab, q, offset],
  )
  const corpus = useAsync(
    () => (tab === 'corpus' ? api.corpus(dataset, { q, limit, offset }) : Promise.resolve(null)),
    [dataset, tab, q, offset],
  )
  const active = tab === 'samples' ? samples : corpus
  const nav = usePagedRecordNavigation({
    items: samples.data?.samples ?? [],
    total: samples.data?.total ?? 0,
    responseOffset: samples.data?.offset ?? offset,
    offset,
    limit,
    selectedKey: sampleId,
    itemKey: (sample) => sample.sample_id,
    onSelect: (sample) => setSampleId(sample.sample_id),
    onOffsetChange: setOffset,
  })

  if (sampleId) {
    return (
      <div className="panel" style={{ marginTop: 14 }}>
        <div className="spread">
          <h3 style={{ margin: 0 }}>{dataset} 样本详情</h3>
          <RecordNav
            hasPrevious={nav.hasPrevious}
            hasNext={nav.hasNext}
            onPrevious={nav.previous}
            onNext={nav.next}
            onBack={() => setSampleId(null)}
            backLabel="返回列表"
            position={nav.position}
            total={samples.data?.total ?? 0}
            busy={samples.loading || nav.navigating}
          />
        </div>
        <SampleDetail dataset={dataset} sampleId={sampleId} />
      </div>
    )
  }

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="record-filters">
        <h3 style={{ margin: 0 }}>
          {dataset} {tab === 'samples' ? '样本' : '语料'}
        </h3>
        <RecordSearch
          placeholder={
            tab === 'samples'
              ? '搜索 sample_id、问题或参考答案'
              : '搜索 doc_id 或文档标题'
          }
          value={term}
          onChange={setTerm}
          onSearch={(value) => {
            setQ(value)
            setOffset(0)
            setSampleId(null)
          }}
        />
      </div>

      {active.loading && <Loading what="内容" />}
      {active.error && <Failed error={active.error} />}

      {tab === 'samples' && samples.data && (
        <>
          <table>
            <thead>
              <tr>
                <th>sample_id</th>
                <th>问题</th>
                <th className="num">gold</th>
                <th>参考答案</th>
              </tr>
            </thead>
            <tbody>
              {samples.data.samples.map((sample) => (
                <tr key={sample.sample_id} onClick={() => setSampleId(sample.sample_id)}>
                  <td className="small mono">{sample.dataset_sample_id}</td>
                  <td className="small">{sample.question}</td>
                  <td className="num">{sample.gold_doc_ids.length}</td>
                  <td className="small muted truncate">{sample.answers.join(' / ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager
            total={samples.data.total}
            offset={offset}
            limit={limit}
            onChange={setOffset}
          />
        </>
      )}

      {tab === 'corpus' && corpus.data && (
        <>
          {corpus.data.docs.map((doc) => (
            <div key={doc.doc_id}>
              <div className="small">
                <span className="tag accent">{doc.doc_id}</span> {doc.title}
              </div>
              <pre className="block" style={{ marginTop: 4 }}>
                {doc.text}
              </pre>
            </div>
          ))}
          {corpus.data.docs.length === 0 && <p className="small muted">没有内容。</p>}
          <Pager
            total={corpus.data.total}
            offset={offset}
            limit={limit}
            onChange={setOffset}
            itemLabels
          />
        </>
      )}
    </div>
  )
}

function SampleDetail({ dataset, sampleId }: { dataset: string; sampleId: string }) {
  const { data, error, loading } = useAsync(
    () => api.sample(dataset, sampleId),
    [dataset, sampleId],
  )
  if (loading) return <Loading what="样本明细" />
  if (error) return <Failed error={error} />
  if (!data) return null

  return (
    <div style={{ marginTop: 12 }}>
      <dl className="kv">
        <dt>sample_id</dt>
        <dd className="mono small">{data.sample_id}</dd>
        <dt>问题</dt>
        <dd>{data.question}</dd>
        <dt>参考答案</dt>
        <dd>{data.answers.join(' / ')}</dd>
        <dt>metadata</dt>
        <dd className="small mono muted">{JSON.stringify(data.metadata)}</dd>
      </dl>

      {data.missing_gold_doc_ids.length > 0 && (
        <div className="note bad">
          <strong>{data.missing_gold_doc_ids.length} 个 gold doc_id 不在语料里。</strong>
          <div className="small mono">{data.missing_gold_doc_ids.join('、')}</div>
        </div>
      )}

      {data.gold_docs.length === 0 ? (
        <p className="small muted">这个数据集没有 gold 文档标注。</p>
      ) : (
        <>
          <h4>gold 文档（{data.gold_docs.length} 篇）</h4>
          {data.gold_docs.map((doc) => (
            <div key={doc.doc_id} style={{ marginBottom: 10 }}>
              <div className="small">
                <span className="tag accent">{doc.doc_id}</span> {doc.title}
              </div>
              <pre className="block" style={{ marginTop: 4 }}>
                {doc.text}
              </pre>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
