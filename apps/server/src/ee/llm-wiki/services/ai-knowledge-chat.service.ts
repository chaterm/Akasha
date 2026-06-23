import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Workspace } from '@docmost/db/types/entity.types';
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

export { KnowledgeAnswerProvider, KnowledgeAnswerProviderInput };

type AiKnowledgeChatInput = {
  workspaceId: string;
  userId: string;
  query: string;
  spaceIds: string[];
  chatContext?: string[];
  workspace?: Workspace;
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
    const rawAnswer = await this.answerProvider.answer({
      query: input.query,
      context: buildAnswerContext(pack),
      chatContext: input.chatContext,
    });
    const citedSourceIds = extractCitedSourceIds(rawAnswer);

    return {
      answer: stripCitationMarkers(rawAnswer),
      citations: filterCitationsByUsedSourceIds(pack.citations, citedSourceIds),
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
