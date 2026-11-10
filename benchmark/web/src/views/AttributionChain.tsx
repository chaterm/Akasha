import type { Snippet } from '../types'
import { Collapsible, SnippetTags } from '../ui'
import { LineageView } from './Compile'

export function AttributionChain({
  question,
  goldPages,
  response,
  goldDocIds,
}: {
  question: string
  goldPages: [string, string | null][]
  response: Record<string, unknown>
  goldDocIds: string[]
}) {
  const snippets = (response.snippets as Snippet[] | undefined) ?? []
  const retrieved = (response.retrievedSources as { title?: string; id?: string }[] | undefined) ?? []
  const citations = (response.citations as { sourcePageId?: string }[] | undefined) ?? []
  const goldPageIds = new Set(goldPages.map(([, page]) => page).filter(Boolean))
  const cited = new Set(citations.map((citation) => citation.sourcePageId).filter(Boolean))
  const isGold = (snippet: Snippet) =>
    (snippet.sourceWindows ?? []).some(
      (window) => window.sourcePageId && goldPageIds.has(window.sourcePageId),
    )
  const graphSnippets = snippets.filter((snippet) => snippet.origin === 'graph')

  return (
    <>
      <div className="chain-summary small">
        <span>gold <strong>{goldDocIds.length}</strong> 篇</span><span>→</span>
        <span>已编译 <strong>{goldPageIds.size}</strong> 篇</span><span>→</span>
        <span>
          检索 <strong>{snippets.length || retrieved.length}</strong> 条
          {snippets.length > 0 && (
            <span className="muted">（命中 gold {snippets.filter(isGold).length}）</span>
          )}
        </span>
        <span>→</span><span>引用 <strong>{citations.length}</strong> 条</span>
        {graphSnippets.length > 0 && (
          <span className="muted">其中图扩展 <strong>{graphSnippets.length}</strong> 条</span>
        )}
      </div>

      <h5>1 · 原文与编译产物</h5>
      {goldPages.length === 0 && <p className="small muted">这个数据集没有 gold 标注。</p>}
      {goldPages.map(([docId, pageId]) => (
        <Collapsible
          key={docId}
          title={
            <>
              {docId}
              {!pageId && <span className="tag bad">未导入</span>}
              {pageId && cited.has(pageId) && <span className="tag ok">被引用</span>}
            </>
          }
        >
          {pageId ? (
            <LineageView pageId={pageId} question={question} />
          ) : (
            <p className="small muted">这篇没有 page_id，编译链路看不了。</p>
          )}
        </Collapsible>
      ))}

      <h5>2 · 检索到的 chunk（{snippets.length}）</h5>
      {snippets.length === 0 && (
        <p className="small muted">
          响应里没有 snippets。
          {retrieved.length > 0 && `只有 ${retrieved.length} 条 retrievedSources（无正文）。`}
        </p>
      )}
      {snippets.map((snippet, index) => (
        <Collapsible
          key={index}
          title={
            <>
              <span className="mono small">#{index + 1}</span> {snippet.title || '（无标题）'}
              {isGold(snippet) && <span className="tag ok">gold</span>}
              <SnippetTags origin={snippet.origin} reasons={snippet.retrievalReasons ?? []} />
            </>
          }
        >
          <pre className="block">{snippet.text || '（无正文）'}</pre>
        </Collapsible>
      ))}
    </>
  )
}
