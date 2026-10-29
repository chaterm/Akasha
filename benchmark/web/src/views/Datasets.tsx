import { useState } from 'react'
import { ApiError, api } from '../api'
import {
  DatasetPicker,
  Failed,
  Field,
  Loading,
  Pager,
  ProviderSelect,
  RecordSearch,
  num,
  pickFile,
  useAction,
  useAsync,
  useProvider,
} from '../ui'

const slugify = (fileName: string) =>
  fileName
    .replace(/\.zip$/i, '')
    .replace(/-space-export$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)

export function Datasets({ onOpenTasks }: { onOpenTasks: () => void }) {
  const { data, error, loading, reload } = useAsync(() => api.datasets(), [])
  const [selected, setSelected] = useState<string[]>([])
  const [preview, setPreview] = useState<{ dataset: string; kind: 'qa' | 'corpus' } | null>(null)
  const [generating, setGenerating] = useState<string | null>(null)
  const [reopened, setReopened] = useState(false)
  const start = useAction<unknown>()
  const upload = useAction<{ dataset: string; docs: number }>()

  if (loading) return <Loading what="数据集状态" />
  if (error) return <Failed error={error} />
  if (!data) return null

  const downloadable = data.datasets.filter((d) => d.downloadable)
  const names = downloadable.map((d) => d.name)
  const targets = selected.length ? selected : names
  const allReady = downloadable.every((d) => d.files_ready)

  const pickArchive = () =>
    pickFile('.zip,application/zip', (file) => {
      const name = window.prompt('数据集名称（小写字母、数字、连字符）', slugify(file.name))?.trim()
      if (!name) return
      upload.run(async () => {
        try {
          return await api.importSpace(name, file)
        } catch (exc) {
          if (!(exc instanceof ApiError && exc.status === 409)) throw exc
          if (!window.confirm(`${name} 已存在，覆盖语料并清空已生成的样本？`)) throw exc
          return await api.importSpace(name, file, true)
        } finally {
          reload()
        }
      })
    })

  return (
    <>
      <div className="spread">
        <h2>数据集</h2>
        <div className="row tight">
          <button className="action small" disabled={upload.busy} onClick={pickArchive}>
            {upload.busy ? '导入中…' : '导入 Akasha 空间'}
          </button>
          {allReady && !reopened && (
            <button className="action small" onClick={() => setReopened(true)}>
              重新下载
            </button>
          )}
          <button className="action small" onClick={reload}>
            刷新
          </button>
        </div>
      </div>

      {start.error && <Failed error={start.error} />}
      {upload.error && <Failed error={upload.error} />}
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
          {data.datasets.flatMap((entry) =>
            entry.files.map((file, index) => (
              <tr key={file.file}>
                {index === 0 && <td rowSpan={entry.files.length}>{entry.name}</td>}
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
                      {(['qa', 'corpus'] as const).map((kind) => {
                        const open = preview?.dataset === entry.name && preview.kind === kind
                        const ready = entry.files.some(
                          (f) => f.kind === kind && f.present && !f.error,
                        )
                        return (
                          <button
                            key={kind}
                            className={`action small${open ? ' primary' : ''}`}
                            disabled={!ready}
                            onClick={() =>
                              setPreview(open ? null : { dataset: entry.name, kind })
                            }
                          >
                            {kind === 'qa' ? '样本' : '语料'}
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
                    </div>
                  </td>
                )}
              </tr>
            )),
          )}
        </tbody>
      </table>

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
