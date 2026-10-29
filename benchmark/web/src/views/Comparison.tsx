import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type {
  AttributionDetail,
  CompileEmbedding,
  CompileRun,
  EvalDetail,
  EvalRun,
  QueryRun,
  QueryStats,
} from '../types'
import { Failed, Loading, downloadText, duration, formatDateTime, useAsync } from '../ui'

type EvalOption = {
  compile: CompileRun
  query: QueryRun
  eval: EvalRun
}

type ComparisonItem = {
  evalId: number
  attributionId: number | null
}

type LoadedItem = {
  option: EvalOption
  detail: EvalDetail
  attribution: AttributionDetail | null
  embedding: CompileEmbedding | null
}

const STORAGE_KEY = 'benchmark-comparison-items'

function readSavedItems(): ComparisonItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is ComparisonItem =>
        typeof item === 'object' && item !== null &&
        typeof (item as ComparisonItem).evalId === 'number' &&
        (typeof (item as ComparisonItem).attributionId === 'number' || (item as ComparisonItem).attributionId === null),
    )
  } catch {
    return []
  }
}

function exportFilename(): string {
  return `benchmark-comparison-${new Date().toISOString().slice(0, 10)}.md`
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function optionLabel(option: EvalOption): string {
  const datasets = option.compile.datasets.join(', ') || '未标注数据集'
  return `${option.eval.name} · ${datasets} · #${option.eval.id}`
}

const DATASET_LABELS: Record<string, string> = {
  hotpotqa: 'HotpotQA',
  musique: 'MuSiQue',
  '2wikimultihopqa': '2WikiMultiHopQA',
  narrativeqa: 'NarrativeQA',
}

const METRIC_SECTIONS = [
  {
    title: '### 3.1 检索质量指标',
    metrics: [
      ['mrr', 'MRR'],
      ['hit@2', 'Hit@2'],
      ['hit@5', 'Hit@5'],
      ['hit@10', 'Hit@10'],
      ['ndcg@2', 'NDCG@2'],
      ['ndcg@5', 'NDCG@5'],
      ['ndcg@10', 'NDCG@10'],
    ],
  },
  {
    title: '### 3.2 Precision / Recall / F1',
    metrics: [
      ['precision@2', 'Precision@2'],
      ['precision@5', 'Precision@5'],
      ['precision@10', 'Precision@10'],
      ['recall@2', 'Recall@2'],
      ['recall@5', 'Recall@5'],
      ['recall@10', 'Recall@10'],
      ['retrieval_f1', 'Retrieval F1 (set)'],
    ],
  },
  {
    title: '### 3.3 覆盖率指标',
    metrics: [
      ['full_coverage@2', 'Full Coverage@2'],
      ['full_coverage@5', 'Full Coverage@5'],
      ['full_coverage@10', 'Full Coverage@10'],
    ],
  },
  {
    title: '### 3.4 引用质量指标',
    metrics: [
      ['citation_precision', 'Citation Precision'],
      ['citation_recall', 'Citation Recall'],
      ['uncited_count', 'Uncited Count'],
      ['uncited_gold_count', 'Uncited Gold Count'],
    ],
  },
  {
    title: '### 3.5 生成答案质量',
    metrics: [
      ['em', 'EM'],
      ['f1', 'F1'],
    ],
  },
  {
    title: '### 3.6 图谱邻居指标',
    metrics: [
      ['graph_neighbor_gold_snippets', 'Graph Neighbor Gold Snippets'],
      ['graph_neighbor_precision', 'Graph Neighbor Precision'],
      ['graph_exclusive_gold_share', 'Graph Exclusive Gold Share'],
    ],
  },
] as const

const TIMELINE_WIDTH = 48

const EMBEDDING_METRICS = [
  ['mrr', 'MRR'],
  ['ndcg@5', 'NDCG@5'],
  ['recall@5', 'Recall@5'],
  ['precision@5', 'Precision@5'],
  ['retrieval_f1', 'Retrieval F1 (set)'],
  ['full_coverage@5', 'Full Coverage@5'],
] as const

const KNOWLEDGE_METRICS = [
  ['mrr', 'MRR'],
  ['ndcg@5', 'NDCG@5'],
  ['recall@5', 'Recall@5'],
  ['precision@5', 'Precision@5'],
  ['retrieval_f1', 'Retrieval F1 (set)'],
  ['full_coverage@5', 'Full Coverage@5'],
  ['citation_precision', 'Citation Precision'],
  ['citation_recall', 'Citation Recall'],
  ['f1', 'F1'],
] as const

function datasetLabel(name: string): string {
  return DATASET_LABELS[name.toLowerCase()] ?? name
}

function embeddingGeneration(item: LoadedItem) {
  const model = item.option.query.embedding_model
  const matching = (item.embedding?.generations ?? []).filter((entry) => entry.model === model)
  if (matching.length === 0) return null
  const merged = matching.reduce((total, entry) => ({
    ...total,
    chunks: total.chunks + entry.chunks,
    total_tokens: sumOrNull(total.total_tokens, entry.total_tokens),
    duration_ms_sum: sumOrNull(total.duration_ms_sum, entry.duration_ms_sum),
  }))

  const rebuild = (item.embedding?.rebuilds ?? []).find((entry) => entry.model === model)
  const usage = rebuild
    ? { total_tokens: rebuild.total_tokens, duration_ms_sum: rebuild.duration_ms_sum }
    : { total_tokens: merged.total_tokens, duration_ms_sum: merged.duration_ms_sum }
  const chunks = rebuild ? rebuild.chunks : merged.chunks
  return {
    ...merged,
    ...usage,
    source: rebuild ? '重建' : '编译',
    duration_ms_mean:
      usage.duration_ms_sum === null || chunks === 0 ? null : usage.duration_ms_sum / chunks,
  }
}

function sumOrNull(left: number | null, right: number | null): number | null {
  return left === null && right === null ? null : (left ?? 0) + (right ?? 0)
}

function embeddingLabel(option: EvalOption): string {
  return option.query.embedding_label ?? option.compile.embedding_label ?? '嵌入模型未知'
}

function modelLabel(option: EvalOption): string {
  const compileModels = Array.from(new Set(
    (option.compile.model_label ?? '').split(' + ').map((value) => value.trim()).filter(Boolean),
  )).join('+')
  const queryModel = option.query.model_label ?? option.eval.model_label ?? `评测 #${option.eval.id}`
  return `${compileModels || '编译模型未知'}->${embeddingLabel(option)}->${queryModel}`
}

function modelNote(item: LoadedItem, index: number): string {
  return `（${circledNumber(index + 1)} ${modelLabel(item.option)}）`
}

function elapsedMs(start: string | null, finish: string | null): number | null {
  if (!start || !finish) return null
  const value = Date.parse(finish) - Date.parse(start)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function timingCell(
  perValue: number | null | undefined,
  total: number | null,
  unit: string,
  concurrency?: number | string | null,
): string {
  const parts: string[] = []
  if (total === null) parts.push('—')
  else {
    parts.push(perValue === null || perValue === undefined ? '—' : `${duration(perValue)}${unit}`)
    parts.push(`共 ${duration(total)}`)
  }
  if (concurrency !== null && concurrency !== undefined) parts.push(`并发 ${concurrency}`)
  return parts.join(' · ')
}

function datasetSummary(item: LoadedItem, dataset: string) {
  return item.detail.datasets.find((entry) => entry.dataset === dataset)
}

function queryStats(item: LoadedItem, dataset: string) {
  return item.option.query.stats[dataset]
}

type Segment = { label: string; startMs: number; durationMs: number; fill: string }

function timelineSegments(stats: QueryStats): { segments: Segment[]; totalMs: number } | null {
  const total = stats.server_total_ms_mean
  if (total === null || total === undefined || total <= 0) return null

  const segments: Segment[] = []
  let cursor = 0
  for (const [value, label, fill] of [
    [stats.rewrite_ms_mean, '改写', '░'],
    [stats.retrieval_ms_mean, '检索', '▓'],
  ] as const) {
    if (value === null || value === undefined) continue
    segments.push({ label, startMs: cursor, durationMs: value, fill })
    cursor += value
  }

  const generation = stats.generation_ms_mean
  if (generation !== null && generation !== undefined) {
    const startMs = Math.max(cursor, total - generation)
    if (startMs - cursor > total * 0.01) {
      segments.push({ label: '未计', startMs: cursor, durationMs: startMs - cursor, fill: '·' })
    }
    segments.push({ label: '生成', startMs, durationMs: generation, fill: '▒' })
  }
  return segments.length > 0 ? { segments, totalMs: total } : null
}

function timelineBlock(item: LoadedItem, dataset: string, index: number): string[] {
  const stats = queryStats(item, dataset)
  if (!stats) return []
  const timeline = timelineSegments(stats)
  if (!timeline) return []

  const { segments, totalMs } = timeline
  const scale = TIMELINE_WIDTH / totalMs

  const cells = Array.from({ length: TIMELINE_WIDTH }, () => ' ')
  for (const segment of segments) {
    const from = Math.min(TIMELINE_WIDTH - 1, Math.round(segment.startMs * scale))
    const to = Math.min(TIMELINE_WIDTH, Math.max(from + 1, Math.round((segment.startMs + segment.durationMs) * scale)))
    cells.fill(segment.fill, from, to)
  }

  const generation = segments.find((segment) => segment.label === '生成')
  const ttft = generation === undefined ? null : stats.ttft_ms_mean ?? null
  const marks = Array.from({ length: TIMELINE_WIDTH }, () => ' ')
  if (ttft !== null && generation !== undefined) {
    const offset = generation.startMs + Math.min(ttft, generation.durationMs)
    const from = Math.round(generation.startMs * scale)
    const to = Math.round((generation.startMs + generation.durationMs) * scale) - 1
    marks[Math.min(Math.max(Math.round(offset * scale), from), Math.max(from, to))] = '▲'
  }

  const legend = segments.map((segment) => `${segment.fill} ${segment.label} ${duration(segment.durationMs)}`)
  if (ttft !== null) legend.push(`▲ TTFT ${duration(ttft)}`)
  return [
    `${circledNumber(index + 1)} ${modelLabel(item.option)} · ${datasetLabel(dataset)}`,
    '',
    `0 ▌${cells.join('')}▐ ${duration(totalMs)}`,
    ...(ttft === null ? [] : [`  ▌${marks.join('')}▐`]),
    '',
    `  ${legend.join('   ')}`,
  ]
}

function metricValue(item: LoadedItem, dataset: string, scope: string, name: string): number | null {
  return datasetSummary(item, dataset)?.scopes[scope]?.[name] ?? null
}

function metricCell(value: number | null, baseline: number | null, rawDelta = false): string {
  if (value === null) return '—'
  const formatted = value.toFixed(4)
  if (baseline === null) return formatted
  const delta = value - baseline
  return rawDelta
    ? `${formatted} (${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`
    : `${formatted} (${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(2)}pp)`
}

type Column = { dataset: string; item: LoadedItem }

const COUNT_METRICS = new Set(['uncited_count', 'uncited_gold_count', 'graph_neighbor_gold_snippets'])

function hasMetric(columns: Column[], scope: string, name: string): boolean {
  return columns.some(({ dataset, item }) => metricValue(item, dataset, scope, name) !== null)
}

function deltaCells(columns: Column[], scope: string, name: string): string[] {
  const baselines = new Map<string, number | null>()
  return columns.map(({ dataset, item }) => {
    const value = metricValue(item, dataset, scope, name)
    if (!baselines.has(dataset)) {
      baselines.set(dataset, value)
      return metricCell(value, null)
    }
    return metricCell(value, baselines.get(dataset) ?? null, COUNT_METRICS.has(name))
  })
}

function tableHeader(headers: string[], numeric = true): string[] {
  return [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `| ${headers.map((_, index) => index === 0 || !numeric ? '---' : '---:').join(' | ')} |`,
  ]
}

function circledNumber(index: number): string {
  return index >= 1 && index <= 20 ? String.fromCodePoint(0x245f + index) : String(index)
}

function inlineText(value: string): ReactNode {
  const parts = value.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>
    return part
  })
}

function MarkdownPreview({ source }: { source: string }) {
  const lines = source.split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.trim()) {
      index += 1
      continue
    }
    if (line.startsWith('```')) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      blocks.push(<pre className="markdown-pre" key={`pre-${index}`}>{body.join('\n')}</pre>)
      continue
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    if (heading) {
      const level = Math.min(4, heading[1]!.length)
      const Heading = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4'
      blocks.push(<Heading key={index}>{inlineText(heading[2]!)}</Heading>)
      index += 1
      continue
    }
    if (line.startsWith('|') && lines[index + 1]?.includes('| ---')) {
      const rows: string[][] = []
      while (index < lines.length && (lines[index] ?? '').startsWith('|')) {
        const cells = (lines[index] ?? '').split('|').slice(1, -1).map((cell) => cell.trim())
        if (!cells.every((cell) => /^:?-{3,}:?$/.test(cell))) rows.push(cells)
        index += 1
      }
      const headers = rows.shift() ?? []
      blocks.push(
        <div className="markdown-table-wrap" key={`table-${index}`}>
          <table className="markdown-table">
            <thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}>{inlineText(cell)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{inlineText(row[cellIndex] ?? '—')}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      )
      continue
    }
    if (line.startsWith('- ')) {
      const list: string[] = []
      while (index < lines.length && (lines[index] ?? '').startsWith('- ')) {
        list.push((lines[index] ?? '').slice(2))
        index += 1
      }
      blocks.push(<ul key={`list-${index}`}>{list.map((item, itemIndex) => <li key={itemIndex}>{inlineText(item)}</li>)}</ul>)
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length && (lines[index] ?? '').trim() && !(lines[index] ?? '').startsWith('#') && !(lines[index] ?? '').startsWith('|') && !(lines[index] ?? '').startsWith('- ')) {
      paragraph.push(lines[index] ?? '')
      index += 1
    }
    blocks.push(<p key={`paragraph-${index}`}>{inlineText(paragraph.join(' '))}</p>)
  }
  return <div className="markdown-preview">{blocks}</div>
}

function buildMarkdown(items: LoadedItem[]): string {
  const datasets = Array.from(new Set(items.flatMap((item) => item.detail.datasets.map((entry) => entry.dataset))))
  const columns: Column[] = datasets.flatMap((dataset) => items
    .filter((item) => datasetSummary(item, dataset))
    .map((item) => ({ dataset, item })))
  const lines: string[] = ['## 一、测试概况', '']
  lines.push(...tableHeader(['编号', '模型', '数据集', '语料页数', '编译耗时', '查询样本数', '查询耗时']))
  for (const [itemIndex, item] of items.entries()) {
    const compileMs = elapsedMs(item.option.compile.created_at, item.option.compile.finished_at)
    const queryMs = elapsedMs(item.option.query.created_at, item.option.query.finished_at)
    for (const dataset of item.detail.datasets.map((entry) => entry.dataset)) {
      const stats = item.option.compile.stats[dataset]
      lines.push(`| ${circledNumber(itemIndex + 1)} | ${escapeCell(modelLabel(item.option))} | ${escapeCell(datasetLabel(dataset))} | ${stats?.imported ?? stats?.docs ?? '—'} | ${timingCell(item.option.compile.pace?.per_page_ms, compileMs, '/篇')} | ${datasetSummary(item, dataset)?.responses_evaluated ?? '—'} | ${timingCell(item.option.query.stats[dataset]?.latency_mean, queryMs, '/条', item.option.query.concurrency)} |`)
    }
  }

  const timelines = columns
    .filter(({ dataset, item }) => (queryStats(item, dataset)?.timed_responses ?? 0) > 0)
    .map(({ dataset, item }) => timelineBlock(item, dataset, items.indexOf(item)))
    .filter((block) => block.length > 0)
  if (timelines.length > 0) {
    lines.push('', '### 1.1 查询耗时时间轴', '')
    lines.push('```')
    for (const [blockIndex, block] of timelines.entries()) {
      if (blockIndex > 0) lines.push('')
      lines.push(...block)
    }
    lines.push('```')
  }

  const costRows = items.flatMap((item, itemIndex) => {
    const generation = embeddingGeneration(item)
    if (!generation) return []
    const tokens = generation.total_tokens
    return [
      `| ${escapeCell(`${circledNumber(itemIndex + 1)} ${embeddingLabel(item.option)}`)} | ${generation.chunks} | ${generation.dimensions ?? '—'} | ${generation.source} | ${tokens === null ? '—' : tokens} | ${timingCell(generation.duration_ms_mean, generation.duration_ms_sum, '/块', item.option.query.embedding_concurrency ?? '远端默认')} |`,
    ]
  })
  if (costRows.length > 0) {
    lines.push('', '### 1.2 嵌入成本', '')
    lines.push(...tableHeader(['嵌入模型', '向量数', '维度', '用量来源', 'token 合计', '嵌入耗时']))
    lines.push(...costRows)
    lines.push('', '用量来源为「编译」时，嵌入耗时是单次调用墙钟相加，不反映并发；「重建」是整批并发的真墙钟。')
  }

  lines.push('', '## 二、路由率对比', '')
  const routeHeaders = ['模型配置', ...datasets.map(datasetLabel)]
  lines.push(...tableHeader(routeHeaders))
  const routeValues = (item: LoadedItem, dataset: string) => {
    const summary = datasetSummary(item, dataset)
    const knowledgeShare = summary?.answer_modes.knowledge
    if (knowledgeShare === undefined) return '—'
    const sampleCount = summary?.responses_evaluated ?? 0
    const knowledge = Math.round(knowledgeShare * sampleCount)
    const general = Math.round((summary?.answer_modes.general ?? 0) * sampleCount)
    return `${(knowledgeShare * 100).toFixed(1)}%（${knowledge}/${general}）`
  }
  for (const [itemIndex, item] of items.entries()) {
    lines.push(`| ${escapeCell(`${circledNumber(itemIndex + 1)} ${modelLabel(item.option)}`)} | ${datasets.map((dataset) => routeValues(item, dataset)).join(' | ')} |`)
  }

  lines.push('', '', '## 三、指标对比')
  for (const section of METRIC_SECTIONS) {
    const availableMetrics = section.metrics.filter(([name]) => hasMetric(columns, 'overall', name))
    if (availableMetrics.length === 0) continue
    lines.push(section.title)
    lines.push(...tableHeader(['指标', ...columns.map(({ dataset, item }) => `${datasetLabel(dataset)} ${modelNote(item, items.indexOf(item))}`)]))
    for (const [name, label] of availableMetrics) {
      lines.push(`| ${label} | ${deltaCells(columns, 'overall', name).join(' | ')} |`)
    }
    lines.push('')
  }

  const embeddingColumns = columns.filter(
    ({ item }) => item.option.query.embedding_model || item.option.query.embedding_label,
  )
  const embeddingModels = new Set(embeddingColumns.map(({ item }) => embeddingLabel(item.option)))
  if (embeddingModels.size > 1) {
    lines.push('### 3.7 嵌入模型检索对比', '')
    lines.push('语料与编译模型相同，只换嵌入模型重算向量后的检索差异。', '')
    lines.push(...tableHeader([
      '指标',
      ...embeddingColumns.map(({ dataset, item }) =>
        `${datasetLabel(dataset)}（${circledNumber(items.indexOf(item) + 1)} ${embeddingLabel(item.option)}）`),
    ]))
    for (const [name, label] of EMBEDDING_METRICS) {
      if (!hasMetric(embeddingColumns, 'overall', name)) continue
      lines.push(`| ${label} | ${deltaCells(embeddingColumns, 'overall', name).join(' | ')} |`)
    }
    lines.push('')
  }

  lines.push(`### 3.${embeddingModels.size > 1 ? 8 : 7} Knowledge-Only 指标对比`, '')
  lines.push(...tableHeader(['指标', ...columns.map(({ dataset, item }) => `${datasetLabel(dataset)} ${modelNote(item, items.indexOf(item))}`)]))
  for (const [name, label] of KNOWLEDGE_METRICS) {
    if (!hasMetric(columns, 'knowledge_only', name)) continue
    lines.push(`| ${label} | ${deltaCells(columns, 'knowledge_only', name).join(' | ')} |`)
  }

  const causes = Array.from(new Set(items.flatMap(({ attribution }) => attribution?.results.map((result) => result.root_cause) ?? []))).sort()
  if (causes.length > 0) {
    lines.push('', '## 四、归因结果对比', '')
    lines.push(...tableHeader(['根因', ...columns.map(({ dataset, item }) => `${datasetLabel(dataset)} ${modelNote(item, items.indexOf(item))}`)]))
    for (const cause of causes) {
      const cells = columns.map(({ dataset, item }) => item.attribution?.results.filter((result) => result.dataset === dataset && result.root_cause === cause).length ?? 0)
      lines.push(`| ${cause} | ${cells.join(' | ')} |`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

export function Comparison() {
  const compiles = useAsync(() => api.compiles(), [])
  const [items, setItems] = useState<ComparisonItem[]>(readSavedItems)
  const [candidateId, setCandidateId] = useState<number | ''>('')
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  const options = useMemo<EvalOption[]>(
    () => (compiles.data?.compiles ?? []).flatMap((compile) => compile.queries.flatMap((query) => query.evals.filter((evaluation) => evaluation.status === 'succeeded').map((evaluation) => ({ compile, query, eval: evaluation })))),
    [compiles.data],
  )
  const optionMap = useMemo(() => new Map(options.map((option) => [option.eval.id, option])), [options])
  const updateItems = (next: ComparisonItem[]) => {
    setItems(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  useEffect(() => {
    if (!compiles.data) return
    const valid = items.filter((item) => optionMap.has(item.evalId))
    if (valid.length !== items.length) updateItems(valid)
  }, [compiles.data, items, optionMap])
  const selectedKey = items.map((item) => `${item.evalId}:${item.attributionId ?? ''}`).join(',')
  const loaded = useAsync<LoadedItem[]>(
    async () => Promise.all(items.flatMap((item) => {
      const option = optionMap.get(item.evalId)
      if (!option) return []
      return [Promise.all([
        api.evalRun(item.evalId),
        item.attributionId === null ? Promise.resolve(null) : api.attribution(item.attributionId),
        api.compileEmbedding(option.compile.id).catch(() => null),
      ]).then(([detail, attribution, embedding]) => ({ option, detail, attribution, embedding }))]
    })),
    [selectedKey, options.length],
  )

  if (compiles.loading) return <Loading what="对比数据" />
  if (compiles.error) return <Failed error={compiles.error} />

  const markdown = loaded.data ? buildMarkdown(loaded.data) : ''
  const available = options.filter((option) => !items.some((item) => item.evalId === option.eval.id))

  return (
    <>
      <div className="spread">
        <div>
          <h2>对比报告</h2>
        </div>
        <button className="action primary" disabled={loaded.data?.length !== items.length || items.length < 2 || loaded.loading || !markdown} onClick={() => downloadText(markdown, exportFilename(), 'text/markdown;charset=utf-8')}>
          {loaded.loading ? '生成中…' : '导出 Markdown'}
        </button>
      </div>

      <section className="panel" style={{ marginTop: 14 }}>
        <div className="panel-head">
          <h3>对比项（{items.length}）</h3>
          <div className="row tight">
            <select value={candidateId} onChange={(event) => setCandidateId(event.target.value ? Number(event.target.value) : '')}>
              <option value="">选择已完成评测…</option>
              {available.map((option) => <option key={option.eval.id} value={option.eval.id}>{optionLabel(option)}</option>)}
            </select>
            <button className="action" disabled={candidateId === ''} onClick={() => {
              const option = optionMap.get(Number(candidateId))
              if (!option) return
              const attribution = [...option.eval.attributions].filter((run) => run.status === 'succeeded').sort((a, b) => b.id - a.id)[0]
              updateItems([...items, { evalId: option.eval.id, attributionId: attribution?.id ?? null }])
              setCandidateId('')
            }}>加入评测</button>
          </div>
        </div>
        {items.length === 0 ? <div className="note plain">请先加入至少两次已完成评测，才能生成对比报告。</div> : (
          <div className="comparison-items">
            {items.map((item, index) => {
              const option = optionMap.get(item.evalId)
              if (!option) return null
              return <div
                className={`comparison-item${dragIndex === index ? ' dragging' : ''}`}
                key={item.evalId}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (dragIndex === null || dragIndex === index) {
                    setDragIndex(null)
                    return
                  }
                  const next = [...items]
                  const [moved] = next.splice(dragIndex, 1)
                  if (moved) next.splice(index, 0, moved)
                  updateItems(next)
                  setDragIndex(null)
                }}
                onDragEnd={() => setDragIndex(null)}
              >
                <div>
                  <span className="comparison-drag-handle" title="拖动调整顺序">☷</span>
                  <strong>{index + 1}. {option.eval.name}</strong> <span className="mono small muted">#{option.eval.id}</span>
                  <div className="small muted">{option.compile.datasets.join(', ')} · {modelLabel(option)} · {option.eval.sample_count} 条样本 · {formatDateTime(option.eval.finished_at ?? option.eval.created_at)}</div>
                </div>
                <div className="row tight">
                  <button className="action small danger" onClick={() => updateItems(items.filter((entry) => entry.evalId !== item.evalId))}>删除</button>
                </div>
              </div>
            })}
          </div>
        )}
        {items.length === 1 && <div className="note warn">还需要再加入一条评测，才能形成对比。</div>}
        {loaded.error && <Failed error={loaded.error} />}
      </section>

      <section className="panel">
        <div className="panel-head"><h3>实时报告预览</h3></div>
        {loaded.loading ? <Loading what="报告" /> : loaded.data?.length ? <MarkdownPreview source={markdown} /> : <div className="note plain">加入评测后将在这里生成报告。</div>}
      </section>
    </>
  )
}
