import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from './api'
import type { Metrics, Provider, ProviderRole, RootCause, RunStatus, Task, TaskStatus } from './types'

export function metric(values: Metrics, name: string, digits = 4): string {
  return num(values[name], digits)
}

export function percent(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(digits)}%`
}

export function num(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined ? '—' : value.toFixed(digits)
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes}m${rest.toString().padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${(minutes % 60).toString().padStart(2, '0')}m`
}

function elapsed(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return '—'
  const start = Date.parse(startedAt)
  if (Number.isNaN(start)) return '—'
  const end = finishedAt ? Date.parse(finishedAt) : Date.now()
  return Number.isNaN(end) ? '—' : duration(end - start)
}

export function Timing({
  startedAt,
  finishedAt,
  latencyMs,
  perLabel = '每条',
}: {
  startedAt: string | null
  finishedAt: string | null
  latencyMs?: number | null
  perLabel?: string
}) {
  const total = elapsed(startedAt, finishedAt)
  const hasLatency = latencyMs !== null && latencyMs !== undefined
  return (
    <span className="small mono muted">
      {hasLatency && (
        <span title={`平均${perLabel} ${Math.round(latencyMs)}ms`}>
          {duration(latencyMs)}/{perLabel}
          {' · '}
        </span>
      )}
      {hasLatency ? `共 ${total}` : total}
    </span>
  )
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[],
): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const hasData = useRef(false)
  const inFlight = useRef(false)
  const queued = useRef(false)

  useEffect(() => {
    hasData.current = false
  }, deps)

  useEffect(() => {
    let alive = true

    if (!hasData.current) {
      setLoading(true)
      setError(null)
    }
    inFlight.current = true
    Promise.resolve()
      .then(load)
      .then((result) => {
        if (!alive) return
        hasData.current = true
        setData(result)
        setError(null)
      })
      .catch((exc: unknown) => {
        if (alive) setError(exc instanceof ApiError ? exc.message : String(exc))
      })
      .finally(() => {
        if (!alive) return
        inFlight.current = false
        setLoading(false)
        if (queued.current) {
          queued.current = false
          setNonce((n) => n + 1)
        }
      })
    return () => {
      alive = false
    }
  }, [...deps, nonce])

  const reload = useCallback(() => {
    if (inFlight.current) {
      queued.current = true
      return
    }
    setNonce((n) => n + 1)
  }, [])

  return { data, error, loading, reload }
}

export function useAction<T>(): {
  run: (task: () => Promise<T>) => void
  busy: boolean
  error: string | null
  result: T | null
  reset: () => void
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<T | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = useCallback((task: () => Promise<T>) => {
    setBusy(true)
    setError(null)
    setResult(null)
    Promise.resolve()
      .then(task)
      .then((value) => alive.current && setResult(value))
      .catch(
        (exc: unknown) =>
          alive.current && setError(exc instanceof ApiError ? exc.message : String(exc)),
      )
      .finally(() => alive.current && setBusy(false))
  }, [])

  return {
    run,
    busy,
    error,
    result,
    reset: useCallback(() => {
      setError(null)
      setResult(null)
    }, []),
  }
}

export function usePoll(active: boolean, reload: () => void) {
  useEffect(() => {
    if (!active) return
    const timer = setInterval(reload, 3000)
    return () => clearInterval(timer)
  }, [active, reload])
}

export function useTaskWatch(reload: () => void, ms = 1000) {
  const [ids, setIds] = useState<number[]>([])

  useEffect(() => {
    if (!ids.length) return
    const timer = setInterval(async () => {
      const settled = await Promise.all(
        ids.map((id) =>
          api.task(id).then(
            (task) =>
              task.target_id !== null || (task.status !== 'queued' && task.status !== 'running'),
            () => true,
          ),
        ),
      )
      setIds((current) => current.filter((id) => !settled[ids.indexOf(id)]))
      reload()
    }, ms)
    return () => clearInterval(timer)
  }, [ids, reload, ms])

  const watch = useCallback((task: Task) => {
    if (!task.params.schedule_at) setIds((current) => [...current, task.id])
    reload()
  }, [reload])

  return { watch, watching: ids.length > 0 }
}

export function useProvider(role: ProviderRole) {
  const { data, error, loading } = useAsync<Provider[]>(() => api.providers(role), [role])
  const list = data ?? []
  const [chosen, setChosen] = useState<number | null>(null)
  const id = list.some((p) => p.id === chosen) ? chosen : list[0]?.id ?? null
  return { list, error, loading, id, setId: setChosen }
}

export function ProviderSelect({
  label,
  provider,
}: {
  label: string
  provider: ReturnType<typeof useProvider>
}) {
  return (
    <Field label={label}>
      <select value={provider.id ?? ''} onChange={(e) => provider.setId(Number(e.target.value))}>
        {provider.list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label} · {p.model}
          </option>
        ))}
      </select>
    </Field>
  )
}

export function pickFile(accept: string, onPick: (file: File) => void): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = accept
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) onPick(file)
  }
  input.click()
}

export function downloadText(content: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export function Loading({ what }: { what: string }) {
  return <p className="muted">正在加载{what}…</p>
}

export function Failed({ error }: { error: string }) {
  return (
    <div className="note bad">
      <strong>请求失败。</strong> {error}
    </div>
  )
}

export const STATUS_TEXT: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '进行中',
  paused: '已暂停',
  succeeded: '已完成',
  failed: '失败',
}

const STATUS_CLASS: Record<TaskStatus, string> = {
  queued: 'tag',
  running: 'tag accent',
  paused: 'tag warn',
  succeeded: 'tag ok',
  failed: 'tag bad',
}

export function StatusTag({ status }: { status: TaskStatus | RunStatus }) {
  return <span className={STATUS_CLASS[status] ?? 'tag'}>{STATUS_TEXT[status] ?? status}</span>
}

export function ModeTag({ mode }: { mode: string | null }) {
  const label = mode ?? 'missing'
  return <span className={`tag ${label === 'knowledge' ? 'ok' : 'warn'}`}>{label}</span>
}

export function RecordSearch({
  value,
  placeholder,
  onChange,
  onSearch,
}: {
  value: string
  placeholder: string
  onChange: (value: string) => void
  onSearch: (value: string) => void
}) {
  const submit = () => onSearch(value.trim())
  return (
    <div className="record-search">
      <input
        aria-label="搜索记录"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && submit()}
      />
      <button className="action small" onClick={submit}>
        搜索
      </button>
    </div>
  )
}

export function AnswerModeFilter({
  counts,
  value,
  onChange,
}: {
  counts: Record<string, number>
  value: string
  onChange: (value: string) => void
}) {
  const modes = [
    'knowledge',
    'general',
    ...Object.keys(counts).filter((mode) => mode !== 'knowledge' && mode !== 'general').sort(),
  ]
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  return (
    <div className="answer-mode-filter">
      <span className="small muted">答案模式</span>
      <button
        className={`action small${value === '' ? ' primary' : ''}`}
        onClick={() => onChange('')}
      >
        全部 · {total}
      </button>
      {modes.map((mode) => (
        <button
          key={mode}
          className={`action small${value === mode ? ' primary' : ''}`}
          onClick={() => onChange(value === mode ? '' : mode)}
        >
          {mode} · {counts[mode] ?? 0}
        </button>
      ))}
    </div>
  )
}

type RunIdentity = {
  id: number
  name: string
  model_label: string | null
  status: RunStatus
  sample_count: number
  success_count: number
}

export function RunCells({ run }: { run: RunIdentity }) {
  return (
    <>
      <td className="mono small">
        {run.name} <span className="muted">#{run.id}</span>
      </td>
      <td className="small">{run.model_label ?? '—'}</td>
      <td>
        <StatusTag status={run.status} />
      </td>
    </>
  )
}

export function RunCountCells({ run }: { run: RunIdentity }) {
  return (
    <>
      <td className="num">{run.sample_count}</td>
      <td className="num">{run.success_count}</td>
    </>
  )
}

export function Pass({ ok, yes = '通过', no = '未通过' }: { ok: boolean; yes?: string; no?: string }) {
  return <span className={`tag ${ok ? 'ok' : 'bad'}`}>{ok ? yes : no}</span>
}

export function Bar({ value, kind }: { value: number; kind?: 'ok' | 'bad' }) {
  return (
    <div className={`bar${kind ? ` ${kind}` : ''}`}>
      <div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  )
}

const ROOT_CAUSE_LABELS: Record<RootCause, { text: string; kind: string }> = {
  answer_incorrect: { text: '答案错误', kind: 'bad' },
  retrieval_evidence_incomplete: { text: '证据链不完整', kind: 'bad' },
  answer_correct: { text: '答案正确', kind: 'ok' },
  generation_ignored_retrieval: { text: '生成未采用检索', kind: 'warn' },
  generation_fallback: { text: '生成端兜底', kind: 'warn' },
  generation_empty: { text: '生成空响应', kind: 'bad' },
  compiled_answer_missing: { text: '编译产物缺答案', kind: 'bad' },
  compiled_away: { text: '编译丢词', kind: 'bad' },
  citation_dropped: { text: '检索到但未被引用', kind: 'warn' },
  retrieval_miss: { text: '检索未命中', kind: 'bad' },
  graph_edge_missing: { text: '多跳缺跳', kind: 'bad' },
  unknown: { text: '未能定位', kind: '' },
}

export function CauseTag({ cause, plain = false }: { cause: string | null; plain?: boolean }) {
  if (!cause) return <span className="muted small">未归因</span>
  const entry = ROOT_CAUSE_LABELS[cause as RootCause]
  if (plain) return <>{entry?.text ?? cause}</>
  return <span className={`tag ${entry?.kind ?? ''}`}>{entry?.text ?? cause}</span>
}

const ORIGIN_LABELS: Record<string, { text: string; kind: string }> = {
  direct: { text: '直接召回', kind: '' },
  graph: { text: '图扩展', kind: 'accent' },
}

const REASON_LABELS: Record<string, string> = {
  semantic: '语义',
  lexical: '词面',
  'exact-title': '标题精确',
}

export function SnippetTags({
  origin,
  reasons,
}: {
  origin?: string | null
  reasons: string[]
}) {
  return (
    <>
      {origin && (
        <span className={`tag ${ORIGIN_LABELS[origin]?.kind ?? ''}`}>
          {ORIGIN_LABELS[origin]?.text ?? origin}
        </span>
      )}
      {reasons.map((reason) => (
        <span key={reason} className="tag">
          {REASON_LABELS[reason] ?? reason}
        </span>
      ))}
    </>
  )
}

export function Pager({
  total,
  offset,
  limit,
  onChange,
  itemLabels = false,
}: {
  total: number
  offset: number
  limit: number
  onChange: (offset: number) => void
  itemLabels?: boolean
}) {
  const pageCount = Math.max(1, Math.ceil(total / limit))
  const currentPage = Math.min(pageCount, Math.floor(offset / limit) + 1)
  const [targetPage, setTargetPage] = useState(String(currentPage))

  useEffect(() => {
    setTargetPage(String(currentPage))
  }, [currentPage])

  if (total <= limit) return null
  const jump = () => {
    const parsed = Number.parseInt(targetPage, 10)
    const page = Number.isFinite(parsed) ? Math.max(1, Math.min(pageCount, parsed)) : currentPage
    setTargetPage(String(page))
    onChange((page - 1) * limit)
  }
  return (
    <div className="pager small muted">
      <button
        className="action small"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        ← {itemLabels ? '上一篇' : '上一页'}
      </button>
      <span>
        {currentPage} / {pageCount}（共 {total} 条）
      </span>
      <button
        className="action small"
        disabled={offset + limit >= total}
        onClick={() => onChange(offset + limit)}
      >
        {itemLabels ? '下一篇' : '下一页'} →
      </button>
      <span className="pager-jump">
        跳到
        <input
          aria-label="跳转页码"
          type="number"
          min={1}
          max={pageCount}
          value={targetPage}
          onChange={(event) => setTargetPage(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && jump()}
        />
        页
        <button className="action small" onClick={jump}>跳转</button>
      </span>
    </div>
  )
}

export function usePagedRecordNavigation<T>({
  items,
  total,
  responseOffset,
  offset,
  limit,
  selectedKey,
  itemKey,
  onSelect,
  onOffsetChange,
}: {
  items: T[]
  total: number
  responseOffset: number
  offset: number
  limit: number
  selectedKey: string | null
  itemKey: (item: T) => string
  onSelect: (item: T) => void
  onOffsetChange: (offset: number) => void
}) {
  const [pending, setPending] = useState<{ offset: number; edge: 'first' | 'last' } | null>(null)
  const index = items.findIndex((item) => itemKey(item) === selectedKey)
  const globalIndex = index < 0 ? -1 : responseOffset + index

  useEffect(() => {
    if (!selectedKey) {
      setPending(null)
      return
    }
    if (!pending || responseOffset !== pending.offset || items.length === 0) return
    onSelect(pending.edge === 'first' ? items[0]! : items[items.length - 1]!)
    setPending(null)
  }, [items, onSelect, pending, responseOffset, selectedKey])

  const previous = () => {
    if (index > 0) {
      onSelect(items[index - 1]!)
      return
    }
    if (offset <= 0) return
    const target = Math.max(0, offset - limit)
    setPending({ offset: target, edge: 'last' })
    onOffsetChange(target)
  }

  const next = () => {
    if (index >= 0 && index < items.length - 1) {
      onSelect(items[index + 1]!)
      return
    }
    if (globalIndex < 0 || globalIndex + 1 >= total) return
    const target = offset + limit
    setPending({ offset: target, edge: 'first' })
    onOffsetChange(target)
  }

  return {
    previous,
    next,
    hasPrevious: globalIndex > 0,
    hasNext: globalIndex >= 0 && globalIndex + 1 < total,
    position: globalIndex >= 0 ? globalIndex + 1 : null,
    navigating: pending !== null,
  }
}

export function RecordNav({
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  onBack,
  backLabel,
  position,
  total,
  busy = false,
}: {
  hasPrevious: boolean
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
  onBack: () => void
  backLabel: string
  position?: number | null
  total?: number
  busy?: boolean
}) {
  return (
    <div className="row tight">
      {position && total ? <span className="small muted">{position} / {total}</span> : null}
      <button className="action small" disabled={!hasPrevious || busy} onClick={onPrevious}>
        ← 上一篇
      </button>
      <button className="action small" disabled={!hasNext || busy} onClick={onNext}>
        下一篇 →
      </button>
      <button className="action small" onClick={onBack}>
        ← {backLabel}
      </button>
    </div>
  )
}

export function Collapsible({
  title,
  children,
  compact = false,
}: {
  title: React.ReactNode
  children: React.ReactNode
  compact?: boolean
}) {
  const [shown, setShown] = useState(false)
  return (
    <div className={compact ? 'collapsible compact' : 'collapsible'} style={{ marginBottom: compact ? 3 : 10 }}>
      <button
        className="action small"
        onClick={() => setShown((s) => !s)}
        style={{ marginBottom: shown ? (compact ? 3 : 8) : 0 }}
      >
        {shown ? '▾' : '▸'} {title}
      </button>
      {shown && children}
    </div>
  )
}

export function ConfigPanel({
  storageKey,
  title,
  children,
}: {
  storageKey: string
  title: string
  children: React.ReactNode
}) {
  const key = `akasha-benchmark:config-panel:${storageKey}`
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== 'closed'
    } catch {
      return true
    }
  })
  const toggle = () => {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(key, next ? 'open' : 'closed')
    } catch {
    }
  }
  return (
    <div className="panel config-panel">
      <div className="panel-head">
        <h3>{title}</h3>
        <button
          className="action small"
          aria-expanded={open}
          onClick={toggle}
        >
          {open ? '↑ 收起配置' : '↓ 展开配置'}
        </button>
      </div>
      {open && <div className="config-panel-body">{children}</div>}
    </div>
  )
}

export function DatasetPicker({
  all,
  selected,
  onChange,
}: {
  all: string[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  return (
    <div className="row tight">
      {all.map((name) => (
        <label key={name} className="check">
          <input
            type="checkbox"
            checked={selected.includes(name)}
            onChange={() =>
              onChange(
                selected.includes(name)
                  ? selected.filter((n) => n !== name)
                  : [...selected, name],
              )
            }
          />
          {name}
        </label>
      ))}
    </div>
  )
}

export function Field({
  label,
  children,
  hint,
  wide,
}: {
  label: string
  children: React.ReactNode
  hint?: string
  wide?: boolean
}) {
  return (
    <label className={`field${wide ? ' wide' : ''}`}>
      <span>
        {label}
        {hint && <span className="muted"> · {hint}</span>}
      </span>
      {children}
    </label>
  )
}

function EyeIcon({ off }: { off?: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {off ? (
        <>
          <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19m-2.72 2.42A9.7 9.7 0 0 1 12 20c-7 0-10-8-10-8a18.4 18.4 0 0 1 5.06-5.94" />
          <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
          <path d="M2 2l20 20" />
        </>
      ) : (
        <>
          <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  )
}

export function SecretField({
  label,
  value,
  onChange,
  hint,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  placeholder?: string
}) {
  const [shown, setShown] = useState(false)
  return (
    <Field label={label} hint={hint}>
      <div className="secret-input">
        <input
          type={shown ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="secret-toggle"
          title={shown ? '隐藏' : '显示'}
          aria-label={shown ? '隐藏' : '显示'}
          onClick={() => setShown(!shown)}
        >
          <EyeIcon off={shown} />
        </button>
      </div>
    </Field>
  )
}

export function CleanupButton({
  what,
  detail,
  onConfirm,
  busy,
}: {
  what: string
  detail: string
  onConfirm: () => void
  busy?: boolean
}) {
  return (
    <button
      className="action small danger"
      disabled={busy}
      onClick={() => window.confirm(`清理${what}？\n\n${detail}`) && onConfirm()}
    >
      清理
    </button>
  )
}
