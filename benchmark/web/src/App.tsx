import { useState } from 'react'
import { Attribution } from './views/Attribution'
import { Comparison } from './views/Comparison'
import { Compile } from './views/Compile'
import { Datasets } from './views/Datasets'
import { Evaluate } from './views/Evaluate'
import { Normalize } from './views/Normalize'
import { Query } from './views/Query'
import { Settings } from './views/Settings'
import { Tasks } from './views/Tasks'
import { Testing } from './views/Testing'

const LAYERS = [
  { key: 'datasets', step: '1', label: '数据集', hint: '下载与校验原始数据' },
  { key: 'normalize', step: '2', label: '归一化', hint: '入 SQLite，不入 Akasha' },
  { key: 'compile', step: '3', label: '编译', hint: '抽子集并入 Akasha 库' },
  { key: 'query', step: '4', label: '查询', hint: '在编译的空间上跑 query' },
  { key: 'evaluate', step: '5', label: '评测', hint: '选指标并计算' },
  { key: 'attribution', step: '6', label: '归因', hint: '完整链路与根因' },
] as const

const CROSS = [
  { key: 'tasks', label: '任务', hint: '实时观测六层的任务' },
  { key: 'settings', label: '配置', hint: 'Akasha 连接与模型端点' },
  { key: 'testing', label: '测试', hint: '轻量的一次完整链路' },
  { key: 'comparison', label: '对比报告', hint: '在线组合多次评测与归因' },
] as const

type ViewKey = (typeof LAYERS)[number]['key'] | (typeof CROSS)[number]['key']

function paramId(params: Record<string, unknown>, key: string): number | null {
  const value = params[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

export function App() {
  const [view, setView] = useState<ViewKey>('datasets')
  const [compileId, setCompileId] = useState<number | null>(null)
  const [queryId, setQueryId] = useState<number | null>(null)
  const [evalId, setEvalId] = useState<number | null>(null)

  const openTasks = () => setView('tasks')
  const selectCompile = (id: number) => {
    setCompileId(id)
    setQueryId(null)
    setEvalId(null)
  }
  const selectQuery = (id: number) => {
    setQueryId(id)
    setEvalId(null)
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Akasha-Benchmark</h1>
        <div className="sub">评测平台</div>

        <nav className="nav">
          {LAYERS.map((layer) => (
            <button
              key={layer.key}
              className={view === layer.key ? 'active' : ''}
              title={layer.hint}
              onClick={() => setView(layer.key)}
            >
              <span className="step">{layer.step}</span>
              {layer.label}
            </button>
          ))}
        </nav>

        <div style={{ height: 14 }} />
        <nav className="nav">
          {CROSS.map((entry) => (
            <button
              key={entry.key}
              className={view === entry.key ? 'active' : ''}
              title={entry.hint}
              onClick={() => setView(entry.key)}
            >
              <span className="step">·</span>
              {entry.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        {view === 'datasets' && <Datasets onOpenTasks={openTasks} />}
        {view === 'normalize' && <Normalize onOpenTasks={openTasks} />}
        {view === 'compile' && (
          <Compile
            activeCompile={compileId}
            onSelect={selectCompile}
            onOpenQuery={(id) => {
              selectCompile(id)
              setView('query')
            }}
          />
        )}
        {view === 'query' && (
          <Query
            activeCompile={compileId}
            activeQuery={queryId}
            onSelectCompile={selectCompile}
            onOpenCompile={(id) => {
              selectCompile(id)
              setView('compile')
            }}
            onEvaluate={(id) => {
              selectQuery(id)
              setView('evaluate')
            }}
          />
        )}
        {view === 'evaluate' && (
          <Evaluate
            activeQuery={queryId}
            activeEval={evalId}
            onSelectQuery={selectQuery}
            onSelectEval={setEvalId}
            onOpenQuery={(compileId, queryId) => {
              setCompileId(compileId)
              setQueryId(queryId)
              setEvalId(null)
              setView('query')
            }}
            onAttribute={(id) => {
              setEvalId(id)
              setView('attribution')
            }}
            onOpenSettings={() => setView('settings')}
          />
        )}
        {view === 'attribution' && (
          <Attribution
            activeEval={evalId}
            onSelectEval={setEvalId}
            onOpenEval={(queryId, evalId) => {
              setQueryId(queryId)
              setEvalId(evalId)
              setView('evaluate')
            }}
            onOpenSettings={() => setView('settings')}
          />
        )}
        {view === 'tasks' && (
          <Tasks
            onNavigate={(stage, targetKind, targetId, params) => {
              if (stage === 'download' || stage === 'generate') {
                setView('datasets')
                return
              }
              if (stage === 'normalize') {
                setView('normalize')
                return
              }
              if (stage === 'compile') {
                setCompileId(targetKind === 'compile' ? targetId : null)
                setView('compile')
                return
              }
              if (stage === 'query') {
                setCompileId(
                  targetKind === 'compile'
                    ? targetId
                    : paramId(params, 'compile_id'),
                )
                setQueryId(targetKind === 'query' ? targetId : null)
                setView('query')
                return
              }
              if (stage === 'evaluate') {
                setQueryId(
                  targetKind === 'query'
                    ? targetId
                    : paramId(params, 'query_id'),
                )
                setEvalId(targetKind === 'eval' ? targetId : null)
                setView('evaluate')
                return
              }
              if (stage === 'attribute') {
                setEvalId(
                  targetKind === 'eval'
                    ? targetId
                    : paramId(params, 'eval_id'),
                )
                setView('attribution')
              }
            }}
          />
        )}
        {view === 'settings' && <Settings />}
        {view === 'testing' && <Testing onOpenTasks={openTasks} />}
        {view === 'comparison' && <Comparison />}
      </main>
    </div>
  )
}
