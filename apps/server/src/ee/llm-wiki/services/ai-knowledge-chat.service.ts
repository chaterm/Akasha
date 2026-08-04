import {
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Workspace } from '@akasha/db/types/entity.types';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import { KNOWLEDGE_ANSWER_PROVIDER } from '../llm-wiki.constants';
import {
  KnowledgeAnswerProvider,
  KnowledgeAnswerProviderInput,
} from './knowledge-answer-provider.service';
import { KnowledgeCitationResolverService } from './knowledge-citation-resolver.service';
import {
  KnowledgeContextPackService,
  KnowledgeSourceWindow,
} from './knowledge-context-pack.service';
import type { KnowledgeCitation } from './knowledge-context-pack.service';
import {
  KnowledgeRetrievalDiagnostics,
  KnowledgeRetrievalService,
} from './knowledge-retrieval.service';
import { KnowledgeSourceAuthorizationService } from './knowledge-source-authorization.service';
import { KnowledgeAuthorizationCache } from './knowledge-source-authorization.cache';

export { KnowledgeAnswerProvider, KnowledgeAnswerProviderInput };

export type AiKnowledgeCitationEvidence = KnowledgeCitation & {
  excerpts: Array<
    Pick<KnowledgeSourceWindow, 'text' | 'sourceRange' | 'quoteHash'>
  >;
};

type AiKnowledgeChatInput = {
  workspaceId: string;
  userId: string;
  chatId?: string;
  query: string;
  spaceIds: string[];
  chatContext?: string[];
  workspace?: Workspace;
  mentionedPageIds?: string[];
  contextPageId?: string;
  attachmentIds?: string[];
  responseMode?: 'knowledge' | 'general';
  onToken?: (token: string) => void;
  onStage?: (stage: 'understanding' | 'retrieval' | 'generation') => void;
};

export type AiKnowledgeChatResult = {
  answer: string;
  answerMode: 'knowledge' | 'no_match' | 'general';
  retrievalQuery?: string;
  citations: ReturnType<
    KnowledgeContextPackService['buildContextPack']
  >['citations'];
  citationEvidence: AiKnowledgeCitationEvidence[];
  retrievedSources: ReturnType<
    KnowledgeContextPackService['buildContextPack']
  >['citations'];
  snippets: Array<{
    id: string;
    title: string;
    text: string;
    retrievalReasons: string[];
    sourceWindows: KnowledgeSourceWindow[];
  }>;
  warnings: ReturnType<
    KnowledgeContextPackService['buildContextPack']
  >['warnings'];
  retrievalReasons: ReturnType<
    KnowledgeContextPackService['buildContextPack']
  >['retrievalReasons'];
  budget: ReturnType<KnowledgeContextPackService['buildContextPack']>['budget'];
  completenessNotice: ReturnType<
    KnowledgeContextPackService['buildContextPack']
  >['completenessNotice'];
  retrievalDiagnostics?: KnowledgeRetrievalDiagnostics & {
    mode: ReturnType<KnowledgeRetrievalService['retrieve']> extends Promise<
      infer Result
    >
      ? Result extends { mode: infer Mode }
        ? Mode
        : never
      : never;
  };
};

@Injectable()
export class AiKnowledgeChatService {
  constructor(
    private readonly retrieval: KnowledgeRetrievalService,
    private readonly contextPack: KnowledgeContextPackService,
    private readonly citationResolver: KnowledgeCitationResolverService,
    @Inject(KNOWLEDGE_ANSWER_PROVIDER)
    private readonly answerProvider: KnowledgeAnswerProvider,
    @Optional() private readonly pageRepo?: PageRepo,
    @Optional()
    private readonly sourceAuthorization?: KnowledgeSourceAuthorizationService,
    @Optional() private readonly attachmentRepo?: AttachmentRepo,
  ) {}

  async chat(input: AiKnowledgeChatInput): Promise<AiKnowledgeChatResult> {
    if (input.workspace && !this.isEnabledForWorkspace(input.workspace)) {
      throw new ForbiddenException('AI knowledge chat is disabled');
    }

    if (input.responseMode === 'general') {
      return this.answerFromGeneralKnowledge(input);
    }

    // One request-scoped authorization cache, bound to this (workspace, user),
    // shared across retrieval, capsule citations and explicit context so the
    // same pages/spaces are not re-authorized multiple times in one request.
    const authCache = new KnowledgeAuthorizationCache({
      workspaceId: input.workspaceId,
      userId: input.userId,
      chatId: input.chatId,
    });

    const retrievalQuery = await this.rewriteRetrievalQuery(input);
    const contextualRetrievalQuery =
      retrievalQuery.trim() !== input.query.trim() ? retrievalQuery : undefined;
    input.onStage?.('retrieval');
    const retrieval = await this.retrieval.retrieve({
      workspaceId: input.workspaceId,
      userId: input.userId,
      query: retrievalQuery,
      spaceIds: input.spaceIds,
      authCache,
    });
    const chunkCitations = retrieval.chunks.length
      ? await this.citationResolver.resolveForChunks({
          workspaceId: input.workspaceId,
          query: retrievalQuery,
          chunks: retrieval.chunks,
        })
      : undefined;
    const capsuleCitations =
      !chunkCitations && retrieval.capsules.length
        ? await this.citationResolver.resolveForCapsules({
            workspaceId: input.workspaceId,
            userId: input.userId,
            capsules: retrieval.capsules,
            authCache,
          })
        : undefined;
    const pack = this.contextPack.buildContextPack({
      chunks: chunkCitations,
      capsules: capsuleCitations,
    });
    const explicit = await this.loadExplicitContext(input, authCache);
    const allCitations = uniqueCitations([
      ...explicit.citations,
      ...pack.citations,
    ]);
    const retrievalDiagnostics = {
      mode: retrieval.mode,
      ...retrieval.diagnostics,
    };
    const hasKnowledgeEvidence =
      explicit.context.trim().length > 0 ||
      pack.primary.some((entry) => entry.sourceWindows.length > 0);

    if (!hasKnowledgeEvidence) {
      const generalAnswer = await this.answerFromGeneralKnowledge(input);
      return {
        ...generalAnswer,
        ...(contextualRetrievalQuery
          ? { retrievalQuery: contextualRetrievalQuery }
          : {}),
        retrievalDiagnostics,
      };
    }

    const answerInput = {
      query: input.query,
      context: [explicit.context, buildAnswerContext(pack)]
        .filter(Boolean)
        .join('\n\n'),
      chatContext: input.chatContext,
    };
    let rawAnswer = '';
    let generatedAnswer: ParsedGeneratedAnswer = {
      mode: 'knowledge',
      content: '',
      hasExplicitModeMarker: false,
    };
    const streamed = Boolean(this.answerProvider.stream);
    input.onStage?.('generation');
    if (this.answerProvider.stream) {
      const streamRouter = new KnowledgeAnswerStreamRouter(input.onToken);
      for await (const token of this.answerProvider.stream(answerInput)) {
        rawAnswer += token;
        streamRouter.push(token);
      }
      streamRouter.finish();
      generatedAnswer = parseGeneratedAnswer(rawAnswer);
    } else {
      rawAnswer = await this.answerProvider.answer(answerInput);
      generatedAnswer = parseGeneratedAnswer(rawAnswer);
    }
    if (
      generatedAnswer.mode === 'no_match' ||
      generatedAnswer.mode === 'general'
    ) {
      const generalAnswer = await this.answerFromGeneralKnowledge({
        ...input,
        onStage: undefined,
      });
      return {
        ...generalAnswer,
        ...(contextualRetrievalQuery
          ? { retrievalQuery: contextualRetrievalQuery }
          : {}),
        retrievalDiagnostics,
      };
    }
    let cleanAnswer = stripCitationMarkers(generatedAnswer.content);
    if (!cleanAnswer) {
      cleanAnswer = buildGenerationUnavailableAnswer(input.query);
      input.onToken?.(cleanAnswer);
    } else if (!streamed) {
      input.onToken?.(cleanAnswer);
    }
    const sourceWindows = pack.primary.flatMap((entry) => entry.sourceWindows);
    const citations = resolveAnswerCitations(
      allCitations,
      generatedAnswer.hasExplicitModeMarker
        ? extractCitedSourceIds(rawAnswer)
        : new Set<string>(),
      sourceWindows,
      explicit.citations.map((citation) => citation.sourcePageId),
    );

    return {
      answer: cleanAnswer,
      answerMode: 'knowledge',
      ...(contextualRetrievalQuery
        ? { retrievalQuery: contextualRetrievalQuery }
        : {}),
      citations,
      citationEvidence: buildCitationEvidence(citations, sourceWindows),
      retrievedSources: allCitations,
      snippets: pack.primary.map((entry) => ({
        id: entry.id,
        title: entry.title,
        text: entry.text,
        retrievalReasons: entry.retrievalReasons,
        sourceWindows: entry.sourceWindows,
      })),
      warnings: pack.warnings,
      retrievalReasons: pack.retrievalReasons,
      budget: pack.budget,
      completenessNotice: pack.completenessNotice,
      retrievalDiagnostics,
    };
  }

  isEnabledForWorkspace(workspace: Workspace): boolean {
    return isKnowledgeAiEnabledForWorkspace(workspace);
  }

  private async answerFromGeneralKnowledge(
    input: AiKnowledgeChatInput,
  ): Promise<AiKnowledgeChatResult> {
    const answerInput: KnowledgeAnswerProviderInput = {
      query: input.query,
      context: '',
      chatContext: input.chatContext,
      mode: 'general',
    };
    const disclaimer = buildGeneralKnowledgeDisclaimer(input.query);
    let generatedAnswer = '';

    input.onStage?.('generation');
    input.onToken?.(disclaimer);
    if (this.answerProvider.stream) {
      const sanitizer = new CitationStreamSanitizer(input.onToken);
      for await (const token of this.answerProvider.stream(answerInput)) {
        generatedAnswer += token;
        sanitizer.push(token);
      }
      sanitizer.finish();
    } else {
      generatedAnswer = await this.answerProvider.answer(answerInput);
      input.onToken?.(stripCitationMarkers(generatedAnswer));
    }

    const cleanAnswer =
      stripCitationMarkers(generatedAnswer) ||
      buildGenerationUnavailableAnswer(input.query);
    if (!generatedAnswer.trim()) {
      input.onToken?.(cleanAnswer);
    }

    return this.buildGeneralKnowledgeResult(input.query, cleanAnswer);
  }

  private buildGeneralKnowledgeResult(
    query: string,
    cleanAnswer: string,
  ): AiKnowledgeChatResult {
    const pack = this.contextPack.buildContextPack({});
    return {
      answer: `${buildGeneralKnowledgeDisclaimer(query)}${cleanAnswer}`,
      answerMode: 'general',
      citations: [],
      citationEvidence: [],
      retrievedSources: [],
      snippets: [],
      warnings: pack.warnings,
      retrievalReasons: [],
      budget: pack.budget,
      completenessNotice: pack.completenessNotice,
    };
  }

  private async rewriteRetrievalQuery(
    input: AiKnowledgeChatInput,
  ): Promise<string> {
    if (!input.chatContext?.length || !this.answerProvider.rewriteQuery) {
      return input.query;
    }

    input.onStage?.('understanding');
    try {
      const rewritten = await this.answerProvider.rewriteQuery({
        query: input.query,
        chatContext: input.chatContext,
      });
      return rewritten.trim() || input.query;
    } catch {
      return input.query;
    }
  }

  private async loadExplicitContext(
    input: AiKnowledgeChatInput,
    authCache?: KnowledgeAuthorizationCache,
  ): Promise<{
    context: string;
    citations: KnowledgeCitation[];
  }> {
    const sections: string[] = [];
    const citations: KnowledgeCitation[] = [];
    const requestedPageIds = unique([
      ...(input.contextPageId ? [input.contextPageId] : []),
      ...(input.mentionedPageIds ?? []),
    ]);

    if (requestedPageIds.length && this.pageRepo && this.sourceAuthorization) {
      const readablePageIds =
        await this.sourceAuthorization.filterReadableSources({
          workspaceId: input.workspaceId,
          userId: input.userId,
          sourcePageIds: requestedPageIds,
          cache: authCache,
        });
      const pages = await this.pageRepo.findManyByIds(readablePageIds, {
        workspaceId: input.workspaceId,
        includeTextContent: true,
      });
      const pageById = new Map(pages.map((page) => [page.id, page]));
      for (const pageId of requestedPageIds) {
        const page = pageById.get(pageId);
        if (!page) continue;
        const kind =
          pageId === input.contextPageId ? 'Current page' : 'Mentioned page';
        sections.push(
          [
            `# ${kind}: ${page.title ?? 'Untitled'}`,
            `Citation IDs: [[cite:${page.id}]]`,
            page.textContent ?? '',
          ].join('\n'),
        );
        citations.push({
          sourcePageId: page.id,
          title: page.title ?? 'Untitled',
          url: `/p/${page.slugId}`,
        });
      }
    }

    if (input.attachmentIds?.length && this.attachmentRepo) {
      const attachments = await Promise.all(
        unique(input.attachmentIds).map((id) =>
          this.attachmentRepo!.findByIdWithContent(id),
        ),
      );
      for (const attachment of attachments) {
        if (
          !attachment ||
          attachment.workspaceId !== input.workspaceId ||
          attachment.creatorId !== input.userId ||
          typeof attachment.textContent !== 'string'
        )
          continue;
        sections.push(
          [
            `# Attachment: ${attachment.fileName}`,
            `Attachment ID: ${attachment.id}`,
            attachment.textContent.slice(0, 20_000),
          ].join('\n'),
        );
      }
    }

    return { context: sections.join('\n\n'), citations };
  }
}

export function isKnowledgeAiEnabledForWorkspace(
  workspace: Workspace,
): boolean {
  const settings = workspace.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return false;
  }

  const aiSettings = (settings as Record<string, unknown>).ai;
  if (
    !aiSettings ||
    typeof aiSettings !== 'object' ||
    Array.isArray(aiSettings)
  ) {
    return false;
  }

  return (aiSettings as Record<string, unknown>).chat === true;
}

type KnowledgeContextPack = ReturnType<
  KnowledgeContextPackService['buildContextPack']
>;

const CITATION_MARKER_PATTERN = /\[\[cite:([^\]\s]+)\]\]/g;
const KNOWLEDGE_ANSWER_MARKER = '[[answer:knowledge]]';
const GENERAL_ANSWER_MARKER = '[[answer:general]]';
const KNOWLEDGE_NO_MATCH_MARKER = '[[knowledge:no_match]]';

type GeneratedAnswerMode = 'knowledge' | 'general' | 'no_match';
type ParsedGeneratedAnswer = {
  mode: GeneratedAnswerMode;
  content: string;
  hasExplicitModeMarker: boolean;
};

const ANSWER_MODE_MARKERS: Array<{
  marker: string;
  mode: GeneratedAnswerMode;
}> = [
  { marker: KNOWLEDGE_ANSWER_MARKER, mode: 'knowledge' },
  { marker: GENERAL_ANSWER_MARKER, mode: 'general' },
  { marker: KNOWLEDGE_NO_MATCH_MARKER, mode: 'no_match' },
];

function buildAnswerContext(pack: KnowledgeContextPack): string {
  if (pack.primary.length === 0) {
    return pack.context;
  }

  return pack.primary
    .map((entry) => {
      const sourceEvidence = entry.sourceWindows.flatMap((window, index) => [
        `## Verified source evidence ${index + 1}: ${window.title}`,
        `Citation ID: [[cite:${window.sourcePageId}]]`,
        window.text,
      ]);
      return [
        `# ${entry.title}`,
        `Citation IDs: ${formatCitationIds(entry.citationSourcePageIds)}`,
        entry.text,
        ...sourceEvidence,
      ].join('\n');
    })
    .join('\n\n');
}

function formatCitationIds(sourcePageIds: string[]): string {
  if (sourcePageIds.length === 0) {
    return 'none';
  }

  return sourcePageIds
    .map((sourcePageId) => `[[cite:${sourcePageId}]]`)
    .join(' ');
}

function extractCitedSourceIds(answer: string): Set<string> {
  return new Set(
    [...answer.matchAll(CITATION_MARKER_PATTERN)].map((match) => match[1]),
  );
}

function stripCitationMarkers(answer: string): string {
  return answer
    .replace(CITATION_MARKER_PATTERN, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function parseGeneratedAnswer(answer: string): ParsedGeneratedAnswer {
  const content = answer.trimStart();
  const matchedMode = ANSWER_MODE_MARKERS.find(({ marker }) =>
    content.startsWith(marker),
  );
  if (!matchedMode) {
    return {
      mode: 'knowledge',
      content: answer,
      hasExplicitModeMarker: false,
    };
  }
  return {
    mode: matchedMode.mode,
    content: content.slice(matchedMode.marker.length).trimStart(),
    hasExplicitModeMarker: true,
  };
}

function filterCitationsByUsedSourceIds(
  citations: KnowledgeCitation[],
  citedSourceIds: Set<string>,
  evidenceBackedSourceIds: Set<string>,
): KnowledgeCitation[] {
  if (citedSourceIds.size === 0) {
    return [];
  }

  return citations.filter(
    (citation) =>
      citedSourceIds.has(citation.sourcePageId) &&
      evidenceBackedSourceIds.has(citation.sourcePageId),
  );
}

function resolveAnswerCitations(
  citations: KnowledgeCitation[],
  citedSourceIds: Set<string>,
  sourceWindows: KnowledgeSourceWindow[],
  explicitSourceIds: string[],
): KnowledgeCitation[] {
  const evidenceBackedSourceIds = new Set([
    ...explicitSourceIds,
    ...sourceWindows.map((window) => window.sourcePageId),
  ]);
  return filterCitationsByUsedSourceIds(
    citations,
    citedSourceIds,
    evidenceBackedSourceIds,
  );
}

function buildCitationEvidence(
  citations: KnowledgeCitation[],
  sourceWindows: KnowledgeSourceWindow[],
): AiKnowledgeCitationEvidence[] {
  const windowsBySourceId = new Map<string, KnowledgeSourceWindow[]>();

  for (const sourceWindow of sourceWindows) {
    const windows = windowsBySourceId.get(sourceWindow.sourcePageId) ?? [];
    const isDuplicate = windows.some(
      (window) =>
        window.quoteHash === sourceWindow.quoteHash &&
        window.sourceRange.startOffset ===
          sourceWindow.sourceRange.startOffset &&
        window.sourceRange.endOffset === sourceWindow.sourceRange.endOffset,
    );
    if (!isDuplicate && windows.length < 2) {
      windows.push(sourceWindow);
      windowsBySourceId.set(sourceWindow.sourcePageId, windows);
    }
  }

  return citations.map((citation) => ({
    ...citation,
    excerpts: (windowsBySourceId.get(citation.sourcePageId) ?? []).map(
      ({ text, sourceRange, quoteHash }) => ({
        text,
        sourceRange,
        quoteHash,
      }),
    ),
  }));
}

function uniqueCitations(citations: KnowledgeCitation[]): KnowledgeCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    if (seen.has(citation.sourcePageId)) return false;
    seen.add(citation.sourcePageId);
    return true;
  });
}

function buildGeneralKnowledgeDisclaimer(query: string): string {
  if (/\p{Script=Han}/u.test(query)) {
    return '> 以下回答基于通用模型知识，未引用企业知识库。\n\n';
  }

  return '> This answer uses general model knowledge and does not cite the workspace knowledge base.\n\n';
}

function buildGenerationUnavailableAnswer(query: string): string {
  if (/\p{Script=Han}/u.test(query)) {
    return '已检索到相关知识，但回答模型当前未能生成内容。请稍后重试，或联系管理员检查 AI 模型配置。';
  }

  return 'Relevant knowledge was retrieved, but the answer model did not produce a response. Try again later or ask an administrator to check the AI model configuration.';
}

class CitationStreamSanitizer {
  private buffer = '';

  constructor(private readonly emit?: (token: string) => void) {}

  push(token: string): void {
    this.buffer += token;
    this.drain(false);
  }

  finish(): void {
    this.drain(true);
  }

  private drain(final: boolean): void {
    while (this.buffer) {
      const markerStart = this.buffer.indexOf('[[cite:');
      if (markerStart < 0) {
        const retained = final ? 0 : possibleMarkerPrefixLength(this.buffer);
        this.output(this.buffer.slice(0, this.buffer.length - retained));
        this.buffer = this.buffer.slice(this.buffer.length - retained);
        return;
      }
      this.output(this.buffer.slice(0, markerStart));
      const markerEnd = this.buffer.indexOf(']]', markerStart + 7);
      if (markerEnd < 0) {
        this.buffer = this.buffer.slice(markerStart);
        if (final) this.buffer = '';
        return;
      }
      this.buffer = this.buffer.slice(markerEnd + 2);
    }
  }

  private output(value: string): void {
    if (value) this.emit?.(value);
  }
}

class KnowledgeAnswerStreamRouter {
  private buffer = '';
  private decision: 'pending' | GeneratedAnswerMode = 'pending';
  private awaitingAnswerContent = false;
  private readonly sanitizer: CitationStreamSanitizer;

  constructor(private readonly emit?: (token: string) => void) {
    this.sanitizer = new CitationStreamSanitizer(emit);
  }

  push(token: string): void {
    if (this.decision === 'no_match' || this.decision === 'general') return;
    if (this.decision === 'knowledge') {
      this.pushAnswerContent(token);
      return;
    }

    this.buffer += token;
    const content = this.buffer.trimStart();
    if (!content) return;
    const matchedMode = ANSWER_MODE_MARKERS.find(({ marker }) =>
      content.startsWith(marker),
    );
    if (matchedMode) {
      const answerContent = content.slice(matchedMode.marker.length);
      this.buffer = '';
      this.startMode(matchedMode.mode, answerContent);
      return;
    }
    if (ANSWER_MODE_MARKERS.some(({ marker }) => marker.startsWith(content))) {
      return;
    }

    this.decision = 'knowledge';
    this.sanitizer.push(this.buffer);
    this.buffer = '';
  }

  finish(): void {
    if (this.decision === 'pending') {
      const parsed = parseGeneratedAnswer(this.buffer);
      this.buffer = '';
      this.startMode(parsed.mode, parsed.content);
    }
    if (this.decision === 'knowledge') {
      this.sanitizer.finish();
    }
  }

  private startMode(mode: GeneratedAnswerMode, content: string): void {
    this.decision = mode;
    if (mode !== 'knowledge') return;
    this.awaitingAnswerContent = true;
    this.pushAnswerContent(content);
  }

  private pushAnswerContent(content: string): void {
    if (this.awaitingAnswerContent) {
      const trimmedContent = content.trimStart();
      if (!trimmedContent) return;
      this.awaitingAnswerContent = false;
      this.sanitizer.push(trimmedContent);
      return;
    }
    this.sanitizer.push(content);
  }
}

function possibleMarkerPrefixLength(value: string): number {
  const marker = '[[cite:';
  for (
    let length = Math.min(marker.length - 1, value.length);
    length > 0;
    length--
  ) {
    if (marker.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
