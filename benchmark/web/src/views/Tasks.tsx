import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Task, TaskDetail, TaskTreeNode } from '../types'
import {
  Bar,
  Failed,
  Loading,
  STATUS_TEXT,
  StatusTag,
  formatDateTime,
  useAction,
  useAsync,
  usePoll,
} from '../ui'

const STAGE_LABELS: Record<string, string> = {
  compile: '编译',
  embed: '嵌入',
  query: '查询',
  evaluate: '评测',
  attribute: '归因',
  download: '下载',
  generate: '生成样本',
  normalize: '归一化',
}
const RUN_LABELS: Record<string, string> = {
  compile: '编译',
  query: '查询',
  eval: '评测',
  attribution: '归因',
}

type Navigate = (
  stage: string,
  targetKind: string | null,
  targetId: number | null,
  params: Record<string, unknown>,
) => void

function tasksIn(nodes: TaskTreeNode[]): Task[] {
  return nodes.flatMap((node) => [
    ...node.tasks,
    ...node.pending_tasks,
    ...tasksIn(node.children),
  ])
}

export function Tasks({
  onNavigate,
}: {
  onNavigate: Navigate
}) {
  const tasks = useAsync(() => api.taskTree(), [])
  const [open, setOpen] = useState<number | null>(null)
  const [showAudit, setShowAudit] = useState(false)
  const cleanup = useAction<{ deleted: number }>()

  const linkedTasks = tasksIn(tasks.data?.compiles ?? [])
  const allTasks = [...linkedTasks, ...(tasks.data?.unlinked_tasks ?? [])]
  usePoll(
    allTasks.some((t) => t.status === 'running' || t.status === 'queued'),
    tasks.reload,
  )

  const removableCount = tasks.data?.inactive_total ?? 0

  return (
    <>
      <h2>任务</h2>

      <div className="spread" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>运行链路</h3>
        <div className="row tight">
          <button className="action small" onClick={tasks.reload}>刷新</button>
          <button className="action small" onClick={() => setShowAudit(!showAudit)}>
            {showAudit ? '收起审计日志' : '审计日志'}
          </button>
          <button
            className="action small danger"
            disabled={removableCount === 0 || cleanup.busy}
            onClick={() => {
              if (!window.confirm('清理所有已结束的任务记录？审计日志会保留。')) return
              cleanup.run(async () => {
                const result = await api.cleanupTasks()
                tasks.reload()
                return result
              })
            }}
          >
            清理已结束（{removableCount}）
          </button>
        </div>
      </div>

      {tasks.loading && <Loading what="任务" />}
      {tasks.error && <Failed error={tasks.error} />}
      {tasks.data?.total_tasks === 0 && !tasks.loading && <p className="muted">还没有任务。</p>}

      {(tasks.data?.compiles ?? []).map((node) => (
        <RunNode key={`${node.kind}-${node.id}`} node={node} open={open} onOpen={setOpen} onChanged={tasks.reload} onNavigate={onNavigate} />
      ))}

      {(tasks.data?.unlinked_tasks.length ?? 0) > 0 && (
        <div className="panel">
          <h3>未关联到运行产物的任务</h3>
          <TaskTable tasks={tasks.data!.unlinked_tasks} open={open} onOpen={setOpen} onChanged={tasks.reload} onNavigate={onNavigate} />
        </div>
      )}

      {cleanup.error && <Failed error={cleanup.error} />}
      {open !== null && <Logs key={open} taskId={open} onClose={() => setOpen(null)} />}
      {showAudit && <Audit />}
    </>
  )
}

function RunNode({
  node,
  open,
  onOpen,
  onChanged,
  onNavigate,
}: {
  node: TaskTreeNode
  open: number | null
  onOpen: (id: number | null) => void
  onChanged: () => void
  onNavigate: Navigate
}) {
  const fixedOpen = node.kind === 'attribution'
  const [expanded, setExpanded] = useState(false)
  return (
    <section className="task-tree-node">
      <div className="task-tree-heading">
        {!fixedOpen && (
          <button className="action small ghost" onClick={() => setExpanded((value) => !value)}>
            {expanded ? '▼' : '▶'}
          </button>
        )}
        <strong>{RUN_LABELS[node.kind] ?? node.kind}</strong>
        <span className="mono">{node.name} #{node.id}</span>
        <StatusTag status={node.status} />
        {node.children.length > 0 && <span className="small muted">{node.children.length} 个下游分支</span>}
      </div>
      {(fixedOpen || expanded) && <div className="task-tree-body">
        {node.tasks.length > 0 && <TaskTable tasks={node.tasks} open={open} onOpen={onOpen} onChanged={onChanged} onNavigate={onNavigate} />}
        {node.pending_tasks.length > 0 && <div className="task-tree-pending"><div className="small muted">等待创建下游运行</div><TaskTable tasks={node.pending_tasks} open={open} onOpen={onOpen} onChanged={onChanged} onNavigate={onNavigate} /></div>}
        {node.children.map((child) => <RunNode key={`${child.kind}-${child.id}`} node={child} open={open} onOpen={onOpen} onChanged={onChanged} onNavigate={onNavigate} />)}
      </div>}
    </section>
  )
}

function TaskTable({
  tasks,
  open,
  onOpen,
  onChanged,
  onNavigate,
}: {
  tasks: Task[]
  open: number | null
  onOpen: (id: number | null) => void
  onChanged: () => void
  onNavigate: Navigate
}) {
  return (
    <table className="records-table tasks-table">
      <thead>
        <tr>
          <th>#</th><th>阶段</th><th>状态</th><th>进度</th><th>参数</th><th>开始</th><th>结束</th><th />
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => (
          <Row
            key={task.id}
            task={task}
            label={STAGE_LABELS[task.stage] ?? task.stage}
            open={open === task.id}
            onToggle={() => onOpen(open === task.id ? null : task.id)}
            onChanged={onChanged}
            onNavigate={onNavigate}
          />
        ))}
      </tbody>
    </table>
  )
}

function Row({
  task,
  label,
  open,
  onToggle,
  onChanged,
  onNavigate,
}: {
  task: Task
  label: string
  open: boolean
  onToggle: () => void
  onChanged: () => void
  onNavigate: Navigate
}) {
  const action = useAction<unknown>()
  const active = task.status === 'running' || task.status === 'queued'
  const resumable = task.status === 'paused' || task.status === 'failed'
  const ratio =
    task.status === 'succeeded'
      ? 1
      : task.progress_total && task.progress_total > 0
        ? task.progress_done / task.progress_total
        : null

  const act = (fn: () => Promise<unknown>) =>
    action.run(async () => {
      const result = await fn()
      onChanged()
      return result
    })

  return (
    <tr className={open ? 'selected' : ''}>
      <td className="mono">{task.id}</td>
      <td>{label}</td>
      <td>
        <StatusTag status={task.status} />
      </td>
      <td style={{ minWidth: 130 }}>
        {ratio !== null ? (
          <>
            <Bar value={ratio} kind={task.status === 'failed' ? 'bad' : undefined} />
            <span className="small mono muted">
              {task.progress_done}/{task.progress_total}
            </span>
          </>
        ) : (
          <span className="small mono muted">{task.progress_done || '—'}</span>
        )}
        {task.progress_note && <span className="small muted"> {task.progress_note}</span>}
      </td>
      <td className="small mono muted truncate" title={JSON.stringify(task.params)}>
        {Object.entries(task.params)
          .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('+') : value}`)
          .join(' ') || '—'}
      </td>
      <td className="small muted mono">{formatDateTime(task.started_at)}</td>
      <td className="small muted mono">{formatDateTime(task.finished_at)}</td>
      <td className="table-actions-cell">
        <div className="table-actions">
          <button className="action small" onClick={onToggle}>
            {open ? '收起' : '日志'}
          </button>
          <button className="action small" onClick={() => onNavigate(task.stage, task.target_kind, task.target_id, task.params)}>跳转</button>
          {active && (
            <button
              className="action small"
              disabled={action.busy}
              title={
                task.stage === 'compile'
                  ? '先调用 Akasha exact-run cancel，确认远端停止后在本地检查点暂停'
                  : task.stage === 'query'
                    ? '当前并发批次完成后暂停，继续前会校验远端模型配置'
                    : '停在下一个可续跑的边界'
              }
              onClick={() => act(() => api.pauseTask(task.id))}
            >
              暂停
            </button>
          )}
          {resumable && (
            <button
              className="action small primary"
              disabled={action.busy}
              onClick={() => act(() => api.resumeTask(task.id))}
            >
              继续
            </button>
          )}
          {!active && (
            <button
              className="action small danger"
              disabled={action.busy}
              title="删任务记录，审计日志保留"
              onClick={() => act(() => api.deleteTask(task.id))}
            >
              清理
            </button>
          )}
        </div>
        {action.error && (
          <div className="small" style={{ color: 'var(--bad)' }}>
            {action.error}
          </div>
        )}
      </td>
    </tr>
  )
}

function Logs({ taskId, onClose }: { taskId: number; onClose: () => void }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    let lastId = 0
    let active = true

    const tick = () => {
      api
        .task(taskId, lastId)
        .then((next) => {
          if (!alive) return
          if (next.logs.length > 0) lastId = next.logs[next.logs.length - 1]!.id
          active = next.status === 'running' || next.status === 'queued'
          setDetail((previous) =>
            previous ? { ...next, logs: [...previous.logs, ...next.logs].slice(-500) } : next,
          )
        })
        .catch((exc: unknown) => {
          if (alive) setError(exc instanceof Error ? exc.message : String(exc))
        })
    }

    tick()
    const timer = setInterval(() => active && tick(), 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [taskId])

  if (error) return <Failed error={error} />
  if (!detail) return <Loading what="任务日志" />

  return (
    <div className="panel">
      <div className="spread">
        <h3 style={{ margin: 0 }}>
          任务 #{detail.id} · {detail.stage} <StatusTag status={detail.status} />
        </h3>
        <div className="row tight small muted">
          {detail.target_kind && (
            <span className="mono">
              {detail.target_kind} #{detail.target_id}
            </span>
          )}
          <button className="action small" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      {detail.error && <div className="note bad">{detail.error}</div>}

      <pre className="block tall" style={{ marginTop: 10 }}>
        {detail.logs.map((entry) => `[${entry.level}] ${entry.message}`).join('\n') ||
          '（还没有输出）'}
      </pre>
      <p className="small muted">
        {STATUS_TEXT[detail.status]} · 参数 {JSON.stringify(detail.params)}
      </p>
    </div>
  )
}

function Audit() {
  const { data, error, loading } = useAsync(() => api.audit(), [])
  if (loading) return <Loading what="审计日志" />
  if (error) return <Failed error={error} />
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>审计日志</h3>
      <pre className="block tall">
        {(data ?? [])
          .map((entry) => `${entry.at} [${entry.stage}/${entry.level}] ${entry.message}`)
          .join('\n') || '（还没有记录）'}
      </pre>
    </div>
  )
}
