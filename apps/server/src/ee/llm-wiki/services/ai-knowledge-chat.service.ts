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

export { KnowledgeAnswerProvider, KnowledgeAnswerProviderInput };

type AiKnowledgeChatInput = {
  workspaceId: string;
  userId: string;
  query: string;
  spaceIds: string[];
  chatContext?: string[];
  workspace?: Workspace;
  mentionedPageIds?: string[];
  contextPageId?: string;
  attachmentIds?: string[];
  onToken?: (token: string) => void;
  onStage?: (stage: 'generation') => void;
};

type AiKnowledgeChatResult = {
  answer: string;
  citations: ReturnType<
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
  retrievalDiagnostics: KnowledgeRetrievalDiagnostics & {
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

    const retrieval = await this.retrieval.retrieve({
      workspaceId: input.workspaceId,
      userId: input.userId,
      query: input.query,
      spaceIds: input.spaceIds,
    });
    const chunkCitations = retrieval.chunks.length
      ? await this.citationResolver.resolveForChunks({
          workspaceId: input.workspaceId,
          chunks: retrieval.chunks,
        })
      : undefined;
    const capsuleCitations =
      !chunkCitations && retrieval.capsules.length
        ? await this.citationResolver.resolveForCapsules({
            workspaceId: input.workspaceId,
            userId: input.userId,
            capsules: retrieval.capsules,
          })
        : undefined;
    const pack = this.contextPack.buildContextPack({
      chunks: chunkCitations,
      capsules: capsuleCitations,
    });
    const explicit = await this.loadExplicitContext(input);
    const answerInput = {
      query: input.query,
      context: [explicit.context, buildAnswerContext(pack)]
        .filter(Boolean)
        .join('\n\n'),
      chatContext: input.chatContext,
    };
    let rawAnswer = '';
    input.onStage?.('generation');
    if (this.answerProvider.stream) {
      const sanitizer = new CitationStreamSanitizer(input.onToken);
      for await (const token of this.answerProvider.stream(answerInput)) {
        rawAnswer += token;
        sanitizer.push(token);
      }
      sanitizer.finish();
    } else {
      rawAnswer = await this.answerProvider.answer(answerInput);
      input.onToken?.(stripCitationMarkers(rawAnswer));
    }
    const citedSourceIds = extractCitedSourceIds(rawAnswer);
    const allCitations = [...explicit.citations, ...pack.citations];

    return {
      answer: stripCitationMarkers(rawAnswer),
      citations: filterCitationsByUsedSourceIds(allCitations, citedSourceIds),
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
      retrievalDiagnostics: {
        mode: retrieval.mode,
        ...retrieval.diagnostics,
      },
    };
  }

  isEnabledForWorkspace(workspace: Workspace): boolean {
    return isKnowledgeAiEnabledForWorkspace(workspace);
  }

  private async loadExplicitContext(input: AiKnowledgeChatInput): Promise<{
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

function buildAnswerContext(pack: KnowledgeContextPack): string {
  if (pack.primary.length === 0) {
    return pack.context;
  }

  return pack.primary
    .map((entry) =>
      [
        `# ${entry.title}`,
        `Citation IDs: ${formatCitationIds(entry.citationSourcePageIds)}`,
        entry.text,
      ].join('\n'),
    )
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

function filterCitationsByUsedSourceIds(
  citations: KnowledgeCitation[],
  citedSourceIds: Set<string>,
): KnowledgeCitation[] {
  if (citedSourceIds.size === 0) {
    return [];
  }

  return citations.filter((citation) =>
    citedSourceIds.has(citation.sourcePageId),
  );
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
