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

const MAX_CHUNK_LENGTH = 1800;
const MIN_SEMANTIC_OVERLAP = 4;

@Injectable()
export class DocmostKnowledgeCompilerRunner implements LlmWikiCompilerRunner {
  async compileSpace(input: CompileSpaceInput): Promise<CompileSpaceResult> {
    const compilerRunId = buildCompilerRunId(input, this.now());
    const warnings: CompileDiagnostic[] = [];
    const artifacts: CompiledKnowledgeArtifact[] = [];
    const sources = input.sources
      .map((source) => ({ ...source, text: normalizeText(source.text) }))
      .filter((source) => {
        if (source.text) return true;

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
    const overview = buildOverviewArtifact({
      input,
      compilerRunId,
      sourceTargets,
    });
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
    const chunks = splitIntoChunks(input.source.text).map((text) => ({
      text,
      claimIndex: 0,
      inputSourceRefs: [sourceRef],
    }));
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
      compileTaskId: `docmost-page:${input.source.sourcePageId}`,
      inputSourceRefs: [sourceRef],
      claims: [
        {
          text: sourceClaim,
          confidence: null,
          inputSourceRefs: [sourceRef],
        },
      ],
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
    compileTaskId: `docmost-overview:${input.input.spaceId}`,
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
  const links: NonNullable<CompiledKnowledgeArtifact['links']> = [];

  for (const target of input.sourceTargets) {
    if (
      target.source.sourcePageId === input.source.sourcePageId ||
      !target.normalizedTitle ||
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

  const graphEdges: NonNullable<CompiledKnowledgeArtifact['graphEdges']> = [];

  for (const target of input.sourceTargets) {
    if (
      target.index <= sourceTarget.index ||
      input.linkedArtifactIds.has(target.artifactId)
    ) {
      continue;
    }

    const sharedTerms = [...sourceTarget.terms]
      .filter((term) => target.terms.has(term))
      .filter((term) => !isCommonTerm(term, input.termDocumentCounts));

    if (sharedTerms.length < MIN_SEMANTIC_OVERLAP) {
      continue;
    }

    graphEdges.push({
      toKnowledgePageId: target.artifactId,
      relation: `相关：${sharedTerms.slice(0, 3).join('、')}`,
      inputSourceRefs: [input.sourceRef, target.sourceRef],
    });
  }

  return graphEdges;
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

function isCommonTerm(term: string, counts: Map<string, number>): boolean {
  const count = counts.get(term) ?? 0;
  return count >= 4;
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
      for (let size = 2; size <= 4; size += 1) {
        for (let index = 0; index <= run.length - size; index += 1) {
          const term = run.slice(index, index + size);
          if (!CJK_STOP_TERMS.has(term)) {
            terms.add(term);
          }
        }
      }
    }
  }

  return terms;
}

function artifactIdForSource(
  input: CompileSpaceInput,
  source: KnowledgeSourceSnapshot,
): string {
  return stableUuid(
    [
      input.workspaceId,
      input.spaceId,
      source.sourcePageId,
      source.sourceVersion,
      source.contentHash,
    ].join(':'),
  );
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

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function buildSourceSummaryClaim(source: KnowledgeSourceSnapshot): string {
  return `${source.title || 'Untitled'}: ${firstLine(source.text)}`;
}

function firstLine(text: string): string {
  return text.split(/\n+/)[0]?.trim() ?? '';
}

function splitIntoChunks(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs.length ? paragraphs : [text]) {
    if (!current) {
      current = paragraph;
      continue;
    }

    const next = `${current}\n\n${paragraph}`;
    if (next.length <= MAX_CHUNK_LENGTH) {
      current = next;
    } else {
      chunks.push(current);
      current = paragraph;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.flatMap(splitOversizedChunk);
}

function splitOversizedChunk(text: string): string[] {
  if (text.length <= MAX_CHUNK_LENGTH) return [text];

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += MAX_CHUNK_LENGTH) {
    chunks.push(text.slice(index, index + MAX_CHUNK_LENGTH));
  }
  return chunks;
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
