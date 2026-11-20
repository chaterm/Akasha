import { useState } from 'react'
import { ApiError, api } from '../api'
import type { DatasetEntry } from '../types'
import {
  DatasetPicker,
  Failed,
  Field,
  Loading,
  Pager,
  ProviderSelect,
  RecordSearch,
  num,
  useAction,
  useAsync,
  useProvider,
} from '../ui'

const PAGE_SIZE = 5


export function Datasets({ onOpenTasks }: { onOpenTasks: () => void }) {
  const { data, error, loading, reload } = useAsync(() => api.datasets(), [])
  const [selected, setSelected] = useState<string[]>([])
  const [preview, setPreview] = useState<{ dataset: string; kind: 'qa' | 'corpus' } | null>(null)
  const [generating, setGenerating] = useState<string | null>(null)
  const [reopened, setReopened] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [offset, setOffset] = useState(0)
  const [kind, setKind] = useState<'all' | 'space' | 'public'>('all')
  const start = useAction<unknown>()
  const upload = useAction<{ dataset: string; docs: number }>()
  const remove = useAction<{ deleted: number; files_removed: number }>()

  if (loading) return <Loading what="数据集状态" />
  if (error) return <Failed error={error} />
  if (!data) return null

  const downloadable = data.datasets.filter((d) => d.downloadable)
  const names = downloadable.map((d) => d.name)
  const targets = selected.length ? selected : names
  const allReady = downloadable.every((d) => d.files_ready)
  const spaceCount = data.datasets.filter((d) => !d.downloadable).length
  const counts = {
    all: data.datasets.length,
    space: spaceCount,
    public: data.datasets.length - spaceCount,
  }
  const visible = data.datasets.filter((d) =>
    kind === 'all' ? true : kind === 'space' ? !d.downloadable : d.downloadable,
  )
  const pageOffset = Math.min(
    offset,
    Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1) * PAGE_SIZE,
  )

  const replaceAs = (send: () => Promise<{ dataset: string; docs: number }>) =>
    upload.run(async () => {
      try {
        return await send()
      } finally {
        setOffset(0)
        reload()
      }
    })

  const importAs = (
    name: string,
    send: (overwrite: boolean) => Promise<{ dataset: string; docs: number }>,
  ) =>
    replaceAs(async () => {
      try {
        return await send(false)
      } catch (exc) {
        if (!(exc instanceof ApiError && exc.status === 409)) throw exc
        if (!window.confirm(`${name} 已存在，覆盖语料并清空已生成的样本？`)) throw exc
        return await send(true)
      }
    })

  const redownload = (entry: DatasetEntry) => {
    if (!window.confirm(`重新下载 ${entry.name}？现有语料和样本会被覆盖。`)) return
    if (entry.space_id) {
      replaceAs(() => api.importAkashaSpace(entry.name, entry.space_id!, true))
      return
    }
    start.run(async () => {
      const task = await api.startTask('download', { datasets: [entry.name] })
      onOpenTasks()
      return task
    })
  }

  const removeDataset = (entry: DatasetEntry) => {
    if (
      !window.confirm(
        `删除数据集 ${entry.name}？\n\n本地语料和归一化数据都会删除，已被编译层引用时会拒绝。`,
      )
    )
      return
    remove.run(async () => {
      const result = await api.deleteDataset(entry.name, { remove_files: true })
      if (generating === entry.name) setGenerating(null)
      if (preview?.dataset === entry.name) setPreview(null)
      reload()
      return result
    })
  }

  return (
    <>
      <div className="spread">
        <h2>数据集</h2>
      </div>

      <div className="record-filters">
        {(
          [
            ['all', '全部'],
            ['space', '空间数据集'],
            ['public', '公开数据集'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={`action small${kind === value ? ' primary' : ''}`}
            onClick={() => {
              setKind(value)
              setOffset(0)
            }}
          >
            {label} · {counts[value]}
          </button>
        ))}
      </div>

      <div className="row tight dataset-actions">
        {kind === 'all' && (
          <button className="action small" onClick={reload}>
            刷新
          </button>
        )}
        {kind === 'space' && (
          <>
            <button
              className={`action small${choosing ? ' primary' : ''}`}
              onClick={() => setChoosing(!choosing)}
            >
              从 Akasha 选择空间
            </button>
            <button className="action small" onClick={reload}>
              刷新
            </button>
          </>
        )}
        {kind === 'public' && (
          <>
            {allReady && !reopened && (
              <button className="action small" onClick={() => setReopened(true)}>
                重新下载
              </button>
            )}
            <button className="action small" onClick={reload}>
              刷新
            </button>
          </>
        )}
      </div>

      {start.error && <Failed error={start.error} />}
      {upload.error && <Failed error={upload.error} />}
      {remove.error && <Failed error={remove.error} />}
      {upload.result && (
        <div className="note">
          已导入 {upload.result.dataset}：{upload.result.docs} 篇语料。下一步点「生成样本」。
        </div>
      )}

      {(!allReady || reopened) && (
        <div className="panel">
          <div className="row">
            <DatasetPicker all={names} selected={selected} onChange={setSelected} />
            <button
              className="action primary"
              disabled={start.busy || !targets.length}
              onClick={() =>
                start.run(async () => {
                  const task = await api.startTask('download', { datasets: targets })
                  onOpenTasks()
                  return task
                })
              }
            >
              {start.busy ? '启动中…' : `下载并校验（${targets.length} 组）`}
            </button>
            {reopened && (
              <button className="action small" onClick={() => setReopened(false)}>
                收起
              </button>
            )}
          </div>
        </div>
      )}

      {choosing && kind === 'space' && (
        <SpacePicker
          busy={upload.busy}
          onImport={(name, spaceId) =>
            importAs(name, (overwrite) => api.importAkashaSpace(name, spaceId, overwrite))
          }
        />
      )}

      <table>
        <thead>
          <tr>
            <th>数据集</th>
            <th>文件</th>
            <th>状态</th>
            <th className="num">体积</th>
            <th className="num">行数</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {visible.slice(pageOffset, pageOffset + PAGE_SIZE).flatMap((entry) =>
            entry.files.map((file, index) => (
              <tr key={file.file}>
                {index === 0 && (
                  <td rowSpan={entry.files.length}>
                    {entry.name}{' '}
                    <span className={`tag ${entry.downloadable ? '' : 'accent'}`}>
                      {entry.downloadable ? '公开' : '空间'}
                    </span>
                  </td>
                )}
                <td className="small mono">{file.file}</td>
                <td>
                  {!file.present ? (
                    <span className={`tag ${entry.downloadable ? 'bad' : 'warn'}`}>
                      {entry.downloadable ? '缺失' : '待生成'}
                    </span>
                  ) : file.error ? (
                    <span className="tag bad" title={file.error}>
                      解析失败
                    </span>
                  ) : (
                    <span className="tag ok">就绪</span>
                  )}
                </td>
                <td className="num">
                  {file.size_bytes ? `${(file.size_bytes / 1e6).toFixed(2)} MB` : '—'}
                </td>
                <td className="num">{num(file.rows)}</td>
                {index === 0 && (
                  <td rowSpan={entry.files.length}>
                    <div className="row tight">
                      {(['qa', 'corpus'] as const).map((fileKind) => {
                        const open =
                          preview?.dataset === entry.name && preview.kind === fileKind
                        const ready = entry.files.some(
                          (f) => f.kind === fileKind && f.present && !f.error,
                        )
                        return (
                          <button
                            key={fileKind}
                            className={`action small${open ? ' primary' : ''}`}
                            disabled={!ready}
                            onClick={() =>
                              setPreview(open ? null : { dataset: entry.name, kind: fileKind })
                            }
                          >
                            {fileKind === 'qa' ? '样本' : '语料'}
                          </button>
                        )
                      })}
                      {!entry.downloadable && (
                        <button
                          className={`action small${generating === entry.name ? ' primary' : ''}`}
                          onClick={() =>
                            setGenerating(generating === entry.name ? null : entry.name)
                          }
                        >
                          生成样本
                        </button>
                      )}
                      <button
                        className="action small"
                        disabled={remove.busy || start.busy || upload.busy}
                        onClick={() => redownload(entry)}
                      >
                        重新下载
                      </button>
                      <button
                        className="action small danger"
                        disabled={remove.busy}
                        onClick={() => removeDataset(entry)}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            )),
          )}
        </tbody>
      </table>

      <Pager
        total={visible.length}
        offset={pageOffset}
        limit={PAGE_SIZE}
        onChange={setOffset}
      />

      {generating && (
        <GeneratePanel
          key={generating}
          dataset={generating}
          hasSamples={Boolean(
            data.datasets
              .find((d) => d.name === generating)
              ?.files.some((f) => f.kind === 'qa' && f.present),
          )}
          onStarted={onOpenTasks}
        />
      )}

      {preview && (
        <RawPreview
          key={`${preview.dataset}:${preview.kind}`}
          dataset={preview.dataset}
          kind={preview.kind}
        />
      )}
    </>
  )
}

function SpacePicker({
  busy,
  onImport,
}: {
  busy: boolean
  onImport: (name: string, spaceId: string) => void
}) {
  const { data, error, loading } = useAsync(() => api.akashaSpaces(), [])
  const [spaceId, setSpaceId] = useState('')
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')

  if (loading) return <Loading what="Akasha 空间" />
  if (error) return <Failed error={error} />
  if (!data) return null

  const choose = (id: string) => {
    const space = data.spaces.find((s) => s.id === id)
    setSpaceId(id)
    setQuery('')
    const datasetName = space ? space.name.trim() || space.slug.trim() || 'space' : ''
    setName(space ? `${datasetName}-数据集` : '')
  }

  const keyword = query.trim().toLowerCase()
  const matched = keyword
    ? data.spaces.filter((s) =>
        `${s.name} ${s.slug} ${s.id} ${s.name} · ${s.slug}`.toLowerCase().includes(keyword),
      )
    : data.spaces
  const current = data.spaces.find((s) => s.id === spaceId)
  const options = current && !matched.includes(current) ? [current, ...matched] : matched

  const handleSpaceInput = (value: string) => {
    setQuery(value)
    const space = data.spaces.find(
      (s) =>
        value === s.name ||
        value === s.slug ||
        value === s.id ||
        value === `${s.name} · ${s.slug}`,
    )
    if (space) choose(space.id)
    else {
      setSpaceId('')
      setName('')
    }
  }

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="row">
        <Field label="空间" hint={`共 ${data.spaces.length} 个`}>
          <input
            className="space-picker-input"
            list="akasha-space-options"
            value={query}
            placeholder={current ? `已选择：${current.name} · ${current.slug}` : '搜索或选择空间'}
            onChange={(e) => handleSpaceInput(e.target.value)}
          />
          <datalist id="akasha-space-options">
            {options.map((s) => (
              <option key={s.id} value={`${s.name} · ${s.slug}`} />
            ))}
          </datalist>
        </Field>
        <Field label="数据集名称" hint="支持 UTF-8 字符">
          <input className="dataset-name-input" value={name} onChange={(e) => setName(e.target.value.trim())} />
        </Field>
      </div>
      <div className="panel-actions">
        <button
          className="action primary"
          disabled={busy || !spaceId || !name}
          onClick={() => onImport(name, spaceId)}
        >
          {busy ? '导入中…' : '导入'}
        </button>
      </div>
    </div>
  )
}

function GeneratePanel({
  dataset,
  hasSamples,
  onStarted,
}: {
  dataset: string
  hasSamples: boolean
  onStarted: () => void
}) {
  const provider = useProvider('generation')
  const [perDoc, setPerDoc] = useState<number | ''>('')
  const [docLimit, setDocLimit] = useState<number | ''>('')
  const [concurrency, setConcurrency] = useState(4)
  const start = useAction<unknown>()

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <h3 style={{ margin: 0 }}>{dataset} 生成样本</h3>
      <p className="small muted">
        逐篇语料让模型出问答对，证据须逐字出现在原文里，否则丢弃。生成后去归一化页归一化。
      </p>
      {provider.error && <Failed error={provider.error} />}
      {start.error && <Failed error={start.error} />}
      {!provider.loading && provider.list.length === 0 && (
        <div className="note warn">还没有样本生成模型，请先在配置页添加。</div>
      )}
      <div className="row">
        <ProviderSelect label="生成模型" provider={provider} />
        <Field label="每篇问题数" hint="留空按内容自适应">
          <input
            type="number"
            min={1}
            value={perDoc}
            onChange={(e) => setPerDoc(e.target.value === '' ? '' : Number(e.target.value))}
            placeholder="自适应"
          />
        </Field>
        <Field label="语料篇数" hint="留空用全部">
          <input
            type="number"
            min={1}
            value={docLimit}
            onChange={(e) => setDocLimit(e.target.value === '' ? '' : Number(e.target.value))}
            placeholder="全部"
          />
        </Field>
        <Field label="并发">
          <input
            type="number"
            min={1}
            max={16}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
          />
        </Field>
      </div>
      <div className="panel-actions">
        <button
          className="action primary"
          disabled={
            start.busy ||
            provider.id === null ||
            (perDoc !== '' && perDoc < 1) ||
            concurrency < 1 ||
            concurrency > 16
          }
          onClick={() => {
            if (hasSamples && !window.confirm(`覆盖 ${dataset} 已生成的样本？`)) return
            start.run(async () => {
              const task = await api.startTask('generate', {
                dataset,
                provider_id: provider.id,
                concurrency,
                ...(perDoc === '' ? {} : { per_doc: perDoc }),
                ...(docLimit === '' ? {} : { doc_limit: docLimit }),
              })
              onStarted()
              return task
            })
          }}
        >
          {start.busy ? '启动中…' : '开始生成'}
        </button>
      </div>
    </div>
  )
}

function RawPreview({ dataset, kind }: { dataset: string; kind: 'qa' | 'corpus' }) {
  const [offset, setOffset] = useState(0)
  const [term, setTerm] = useState('')
  const [q, setQ] = useState('')
  const limit = 1
  const { data, error, loading } = useAsync(
    () => api.rawSamples(dataset, { kind, q, limit, offset }),
    [dataset, kind, q, offset],
  )

  if (loading) return <Loading what="原始样例" />
  if (error) return <Failed error={error} />
  if (!data) return null

  const row = data.rows[0]

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="spread">
        <h3 style={{ margin: 0 }}>
          {dataset} 原始{kind === 'qa' ? '样本' : '语料'}
        </h3>
        <span className="small muted mono">{data.source_file}</span>
      </div>
      <div className="record-filters" style={{ marginTop: 10 }}>
        <RecordSearch
          placeholder={`搜索原始${kind === 'qa' ? '样本' : '语料'}的任意字段`}
          value={term}
          onChange={setTerm}
          onSearch={(value) => {
            setQ(value)
            setOffset(0)
          }}
        />
      </div>
      <pre className="block tall">{row ? JSON.stringify(row, null, 2) : '（没有内容）'}</pre>
      <Pager total={data.total} offset={offset} limit={limit} onChange={setOffset} itemLabels />
    </div>
  )
}
