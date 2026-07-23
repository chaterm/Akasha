import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  CompiledKnowledgeArtifact,
  CompileDiagnostic,
  CompileSpaceInput,
  CompileSpaceResult,
} from '../types/compiler-artifact.types';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';
import { KnowledgeSourceRef } from '../types/knowledge.types';
import { LlmWikiCompilerRunner } from './llm-wiki-file-compiler.runner';
import { chunkKnowledgeSource } from '../chunking/knowledge-structural-chunker';

const MIN_SEMANTIC_ANCHORS = 2;
const MIN_SEMANTIC_SCORE = 6;
const MAX_SEMANTIC_EDGES_PER_PAGE = 6;

@Injectable()
export class DocmostKnowledgeCompilerRunner implements LlmWikiCompilerRunner {
  async compileSpace(input: CompileSpaceInput): Promise<CompileSpaceResult> {
    const compilerRunId = buildCompilerRunId(input, this.now());
    const warnings: CompileDiagnostic[] = [];
    const artifacts: CompiledKnowledgeArtifact[] = [];
    const sources = input.sources.filter((source) => {
      if (source.text.trim()) return true;

      warnings.push({
        code: 'empty_source',
        message: 'Source page has no text content and was skipped.',
        sourcePageId: source.sourcePageId,
      });
      return false;
    });
    const sourceTargets = sources.map((source, index) => ({
      source,
      index,
      artifactId: artifactIdForSource(input, source),
      normalizedTitle: normalizeForMatch(source.title),
      sourceRef: toSourceRef(source),
      terms: extractSemanticTerms(`${source.title}\n${source.text}`),
    }));
    const termDocumentCounts = countTermDocuments(sourceTargets);

    for (const source of sources) {
      artifacts.push(
        this.compileSource({
          input,
          source,
          compilerRunId,
          sourceTargets,
          termDocumentCounts,
        }),
      );
    }
    const overview =
      input.compileMode === 'pages'
        ? undefined
        : buildOverviewArtifact({ input, compilerRunId, sourceTargets });
    if (overview) {
      artifacts.push(overview);
    }

    return {
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      sources: input.sources.map(toSourceRef),
      compilerVersion: input.compilerVersion,
      promptVersion: input.promptVersion,
      compilerRunId,
      artifacts,
      diagnostics: { warnings, errors: [] },
    };
  }

  protected now(): Date {
    return new Date();
  }

  private compileSource(input: {
    input: CompileSpaceInput;
    source: KnowledgeSourceSnapshot;
    compilerRunId: string;
    sourceTargets: SourceTarget[];
    termDocumentCounts: Map<string, number>;
  }): CompiledKnowledgeArtifact {
    const sourceRef = toSourceRef(input.source);
    const sourceClaim = buildSourceSummaryClaim(input.source);
    const structuralParents = chunkKnowledgeSource({
      pageTitle: input.source.title || 'Untitled',
      text: input.source.text,
      content: input.source.content,
    });
    const parentSections = structuralParents.map((parent) => ({
      stableKey: parent.stableKey,
      headingPath: parent.headingPath,
      text: parent.text,
      contentHash: parent.quoteHash,
      startOffset: parent.startOffset,
      endOffset: parent.endOffset,
      inputSourceRefs: [
        withSourceRange(
          sourceRef,
          parent.startOffset,
          parent.endOffset,
          parent.quoteHash,
        ),
      ],
    }));
    const chunks = structuralParents.flatMap((parent) =>
      parent.children.map((child) => ({
        text: child.text,
        embeddingText: child.embeddingText,
        contentHash: child.quoteHash,
        stableKey: child.stableKey,
        parentStableKey: parent.stableKey,
        chunkRole: 'child' as const,
        retrievalChannel: 'evidence' as const,
        headingPath: parent.headingPath,
        startOffset: child.startOffset,
        endOffset: child.endOffset,
        claimIndex: 0,
        inputSourceRefs: [
          withSourceRange(
            sourceRef,
            child.startOffset,
            child.endOffset,
            child.quoteHash,
          ),
        ],
      })),
    );
    const links = buildSameSpaceLinks({
      source: input.source,
      sourceRef,
      sourceTargets: input.sourceTargets,
    });
    const linkedArtifactIds = new Set(
      links
        .map((link) => link.toKnowledgePageId)
        .filter((id): id is string => Boolean(id)),
    );
    const graphEdges = buildSemanticGraphEdges({
      source: input.source,
      sourceRef,
      sourceTargets: input.sourceTargets,
      termDocumentCounts: input.termDocumentCounts,
      linkedArtifactIds,
    });

    return {
      artifactId: artifactIdForSource(input.input, input.source),
      workspaceId: input.input.workspaceId,
      spaceId: input.input.spaceId,
      title: input.source.title || 'Untitled',
      artifactKind: 'source_summary',
      contentMarkdown: `# ${input.source.title || 'Untitled'}\n\n${input.source.text}`,
      sourcePageIds: [input.source.sourcePageId],
      compilerVersion: input.input.compilerVersion,
      promptVersion: input.input.promptVersion,
      compilerRunId: input.compilerRunId,
      compileTaskId: `akasha-page:${input.source.sourcePageId}`,
      inputSourceRefs: [sourceRef],
      claims: [
        {
          text: sourceClaim,
          confidence: null,
          inputSourceRefs: [sourceRef],
        },
      ],
      parentSections,
      chunks,
      links: links.length > 0 ? links : undefined,
      graphEdges: graphEdges.length > 0 ? graphEdges : undefined,
    };
  }
}

function buildOverviewArtifact(input: {
  input: CompileSpaceInput;
  compilerRunId: string;
  sourceTargets: SourceTarget[];
}): CompiledKnowledgeArtifact | undefined {
  if (input.sourceTargets.length < 2) return undefined;

  const inputSourceRefs = input.sourceTargets.map((target) => target.sourceRef);
  const overviewText = input.sourceTargets
    .map(
      (target) =>
        `${target.source.title || 'Untitled'}: ${firstLine(target.source.text)}`,
    )
    .join('\n\n');

  return {
    artifactId: stableUuid(
      [
        input.input.workspaceId,
        input.input.spaceId,
        'overview',
        ...inputSourceRefs.map(
          (source) =>
            `${source.sourcePageId}:${source.sourceVersion}:${source.contentHash}`,
        ),
      ].join(':'),
    ),
    workspaceId: input.input.workspaceId,
    spaceId: input.input.spaceId,
    title: 'Space knowledge overview',
    artifactKind: 'overview',
    contentMarkdown: `# Space knowledge overview\n\n${overviewText}`,
    sourcePageIds: inputSourceRefs.map((source) => source.sourcePageId),
    compilerVersion: input.input.compilerVersion,
    promptVersion: input.input.promptVersion,
    compilerRunId: input.compilerRunId,
    compileTaskId: `akasha-overview:${input.input.spaceId}`,
    inputSourceRefs,
    claims: [
      {
        text: `This overview summarizes ${input.sourceTargets.length} source pages in the selected space.`,
        confidence: null,
        inputSourceRefs,
      },
    ],
    chunks: [
      {
        text: overviewText,
        claimIndex: 0,
        inputSourceRefs,
      },
    ],
  };
}

type SourceTarget = {
  source: KnowledgeSourceSnapshot;
  index: number;
  artifactId: string;
  normalizedTitle: string;
  sourceRef: KnowledgeSourceRef;
  terms: Set<string>;
};

function buildSameSpaceLinks(input: {
  source: KnowledgeSourceSnapshot;
  sourceRef: KnowledgeSourceRef;
  sourceTargets: SourceTarget[];
}): NonNullable<CompiledKnowledgeArtifact['links']> {
  const haystack = normalizeForMatch(
    `${input.source.title}\n${input.source.text}`,
  );
  const explicitTargetPageIds = new Set(
    input.source.references
      .filter(
        (reference) =>
          reference.kind === 'same_space_reference' &&
          reference.targetSpaceId === input.source.spaceId,
      )
      .map((reference) => reference.targetPageId),
  );
  const links: NonNullable<CompiledKnowledgeArtifact['links']> = [];

  for (const targetPageId of explicitTargetPageIds) {
    if (targetPageId === input.source.sourcePageId) continue;
    const target = input.sourceTargets.find(
      (candidate) => candidate.source.sourcePageId === targetPageId,
    );
    links.push({
      linkType: 'same_space_reference',
      linkText: target?.source.title ?? '',
      targetPageId,
      targetSpaceId: input.source.spaceId,
      toKnowledgePageId:
        target?.artifactId ??
        artifactIdForSourcePage(
          input.source.workspaceId,
          input.source.spaceId,
          targetPageId,
        ),
      isDangling: false,
      inputSourceRefs: [input.sourceRef],
    });
  }

  for (const target of input.sourceTargets) {
    if (
      target.source.sourcePageId === input.source.sourcePageId ||
      !target.normalizedTitle ||
      explicitTargetPageIds.has(target.source.sourcePageId) ||
      !haystack.includes(target.normalizedTitle)
    ) {
      continue;
    }

    links.push({
      linkType: 'same_space_reference',
      linkText: target.source.title,
      targetPageId: target.source.sourcePageId,
      targetSpaceId: target.source.spaceId,
      toKnowledgePageId: target.artifactId,
      isDangling: false,
      inputSourceRefs: [input.sourceRef],
    });
  }

  return links;
}

function buildSemanticGraphEdges(input: {
  source: KnowledgeSourceSnapshot;
  sourceRef: KnowledgeSourceRef;
  sourceTargets: SourceTarget[];
  termDocumentCounts: Map<string, number>;
  linkedArtifactIds: Set<string>;
}): NonNullable<CompiledKnowledgeArtifact['graphEdges']> {
  const sourceTarget = input.sourceTargets.find(
    (target) => target.source.sourcePageId === input.source.sourcePageId,
  );
  if (!sourceTarget) return [];

  const candidates: Array<{
    target: SourceTarget;
    anchors: string[];
    score: number;
  }> = [];

  for (const target of input.sourceTargets) {
    if (
      target.index <= sourceTarget.index ||
      input.linkedArtifactIds.has(target.artifactId)
    ) {
      continue;
    }

    const sharedTerms = [...sourceTarget.terms]
      .filter((term) => target.terms.has(term))
      .filter(
        (term) =>
          !isCommonTerm(
            term,
            input.termDocumentCounts,
            input.sourceTargets.length,
          ),
      );
    const anchors = maximalTerms(sharedTerms).sort(
      (a, b) =>
        semanticTermWeight(
          b,
          input.termDocumentCounts,
          input.sourceTargets.length,
        ) -
        semanticTermWeight(
          a,
          input.termDocumentCounts,
          input.sourceTargets.length,
        ),
    );
    const score = anchors.reduce(
      (total, term) =>
        total +
        semanticTermWeight(
          term,
          input.termDocumentCounts,
          input.sourceTargets.length,
        ),
      0,
    );

    if (anchors.length < MIN_SEMANTIC_ANCHORS || score < MIN_SEMANTIC_SCORE) {
      continue;
    }

    candidates.push({ target, anchors, score });
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SEMANTIC_EDGES_PER_PAGE)
    .map(({ target, anchors }) => ({
      toKnowledgePageId: target.artifactId,
      relation: `共同主题：${anchors.slice(0, 3).join('、')}`,
      inputSourceRefs: [input.sourceRef, target.sourceRef],
    }));
}

function countTermDocuments(
  sourceTargets: SourceTarget[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const target of sourceTargets) {
    for (const term of target.terms) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return counts;
}

function isCommonTerm(
  term: string,
  counts: Map<string, number>,
  documentCount: number,
): boolean {
  const count = counts.get(term) ?? 0;
  return count >= 4 && count / Math.max(documentCount, 1) >= 0.65;
}

function maximalTerms(terms: string[]): string[] {
  const uniqueTerms = [...new Set(terms)];
  return uniqueTerms.filter(
    (term) =>
      !uniqueTerms.some(
        (candidate) =>
          candidate !== term &&
          candidate.length > term.length &&
          candidate.includes(term),
      ),
  );
}

function semanticTermWeight(
  term: string,
  counts: Map<string, number>,
  documentCount: number,
): number {
  const documentFrequency = counts.get(term) ?? 1;
  const inverseDocumentFrequency =
    Math.log((documentCount + 1) / (documentFrequency + 1)) + 1;
  const lengthWeight = /\p{Script=Han}/u.test(term)
    ? Math.min(term.length, 4) / 2
    : Math.min(term.length, 8) / 4;
  return inverseDocumentFrequency * Math.max(lengthWeight, 1);
}

function extractSemanticTerms(text: string): Set<string> {
  const terms = new Set<string>();
  const normalized = text.toLowerCase();
  const tokens = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];

  for (const token of tokens) {
    if (/^[a-z0-9][a-z0-9_-]*$/i.test(token)) {
      if (token.length >= 3 && !LATIN_STOP_WORDS.has(token)) {
        terms.add(token);
      }
      continue;
    }

    const cjkRuns = token.match(/\p{Script=Han}+/gu) ?? [];
    for (const run of cjkRuns) {
      for (const term of segmentCjkTerms(run)) {
        if (!CJK_STOP_TERMS.has(term)) {
          terms.add(term);
        }
      }
    }
  }

  return terms;
}

type CjkSegment = { segment: string; isWordLike?: boolean };
type CjkSegmenter = { segment: (text: string) => Iterable<CjkSegment> };

const cjkSegmenter = createCjkSegmenter();

function createCjkSegmenter(): CjkSegmenter | undefined {
  const Segmenter = (
    Intl as unknown as {
      Segmenter?: new (
        locale: string,
        options: { granularity: 'word' },
      ) => CjkSegmenter;
    }
  ).Segmenter;
  return Segmenter ? new Segmenter('zh', { granularity: 'word' }) : undefined;
}

function segmentCjkTerms(run: string): string[] {
  if (!cjkSegmenter) {
    const fallback: string[] = [];
    for (let size = 2; size <= 4; size += 1) {
      for (let index = 0; index <= run.length - size; index += 1) {
        fallback.push(run.slice(index, index + size));
      }
    }
    return fallback;
  }

  const words = [...cjkSegmenter.segment(run)]
    .filter((segment) => segment.isWordLike !== false)
    .map((segment) => segment.segment.trim())
    .filter(Boolean);
  const terms = new Set<string>();

  for (let start = 0; start < words.length; start += 1) {
    let term = '';
    for (let end = start; end < Math.min(words.length, start + 3); end += 1) {
      term += words[end];
      if (term.length >= 2 && term.length <= 8) {
        terms.add(term);
      }
    }
  }

  return [...terms];
}

function artifactIdForSource(
  input: CompileSpaceInput,
  source: KnowledgeSourceSnapshot,
): string {
  return artifactIdForSourcePage(
    input.workspaceId,
    input.spaceId,
    source.sourcePageId,
  );
}

function artifactIdForSourcePage(
  workspaceId: string,
  spaceId: string,
  sourcePageId: string,
): string {
  return stableUuid([workspaceId, spaceId, sourcePageId].join(':'));
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const LATIN_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'page',
  'doc',
  'docs',
]);

const CJK_STOP_TERMS = new Set([
  '这个',
  '那个',
  '一个',
  '主要',
  '包括',
  '使用',
  '用于',
  '进行',
  '可以',
  '需要',
  '相关',
  '页面',
  '内容',
  '文档',
  '项目',
  '方案',
  '服务',
  '系统',
]);

function buildSourceSummaryClaim(source: KnowledgeSourceSnapshot): string {
  return `${source.title || 'Untitled'}: ${firstLine(source.text)}`;
}

function firstLine(text: string): string {
  return text.split(/\n+/)[0]?.trim() ?? '';
}

function buildCompilerRunId(input: CompileSpaceInput, now: Date): string {
  return `${input.workspaceId}:${input.spaceId}:${now.toISOString()}`;
}

function toSourceRef(source: KnowledgeSourceSnapshot): KnowledgeSourceRef {
  return {
    workspaceId: source.workspaceId,
    spaceId: source.spaceId,
    sourcePageId: source.sourcePageId,
    sourceVersion: source.sourceVersion,
    contentHash: source.contentHash,
  };
}

function withSourceRange(
  source: KnowledgeSourceRef,
  startOffset: number,
  endOffset: number,
  quoteHash: string,
): KnowledgeSourceRef {
  return {
    ...source,
    sourceRange: { startOffset, endOffset },
    quoteHash,
  };
}

function stableUuid(input: string): string {
  const hash = createHash('sha256').update(input).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) +
      hash.slice(18, 20),
    hash.slice(20, 32),
  ].join('-');
}
