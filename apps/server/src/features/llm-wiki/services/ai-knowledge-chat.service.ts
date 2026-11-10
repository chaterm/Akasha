import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { User, Workspace } from '@akasha/db/types/entity.types';
import {
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { createHash } from 'crypto';
import {
  AiChatDebugTiming,
  measureAiChatPhase,
} from '../../../common/observability/ai-chat-debug-timing';
import { KNOWLEDGE_ANSWER_PROVIDER } from '../llm-wiki.constants';
import {
  KnowledgeAnswerProvider,
  KnowledgeAnswerProviderInput,
} from './knowledge-answer-provider.service';
import { KnowledgeCitationResolverService } from './knowledge-citation-resolver.service';
import type { KnowledgeCitation, KnowledgeContextPackingItem } from './knowledge-context-pack.service';
import {
  KnowledgeContextPackService,
  KnowledgeSourceWindow,
} from './knowledge-context-pack.service';
import {
  KnowledgeRetrievalAuthorizationMode,
  KnowledgeRetrievalDiagnostics,
  KnowledgeRetrievalObservation,
  KnowledgeRetrievalOrigin,
  KnowledgeRetrievalScope,
  KnowledgeRetrievalService,
} from './knowledge-retrieval.service';
import { KnowledgeAuthorizationCache } from './knowledge-source-authorization.cache';
import { KnowledgeSourceAuthorizationService } from './knowledge-source-authorization.service';
import { ErrorCode, errorBody } from '../../../common/errors/error-codes';

export { KnowledgeAnswerProvider, KnowledgeAnswerProviderInput };

export type AiKnowledgeCitationEvidence = KnowledgeCitation & {
  excerpts: Array<
    Pick<KnowledgeSourceWindow, 'text' | 'sourceRange' | 'quoteHash'>
  >;
};

export type KnowledgeContextObservation = {
  text: string;
  items: Array<{
    itemId: string;
    pageId: string;
    text: string;
    tokenCount: number;
  }>;
  usedTokens: number;
  maxTokens: number;
  dropped: Array<{ itemId: string; pageId: string; reason: string }>;
};

type AiKnowledgeChatInput = {
  workspaceId: string;
  userId: string;
  supplementalUserId?: string;
  chatId?: string;
  query: string;
  spaceIds: string[];
  labelNames?: string[];
  chatContext?: string[];
  workspace?: Workspace;
  mentionedPageIds?: string[];
  contextPageId?: string;
  attachmentIds?: string[];
  responseMode?: 'knowledge' | 'general';
  generalKnowledgeEnabled?: boolean;
  scoreThreshold?: number;
  rawResultsOnly?: boolean;
  queryRewriteEnabled?: boolean;
  onToken?: (token: string) => void;
  onStage?: (stage: 'understanding' | 'retrieval' | 'generation') => void;
  onThinking?: (event: AiChatThinkingEvent) => void;
  debugTiming?: AiChatDebugTiming;
  collectTimings?: boolean;
};


type TimedChatInput = AiKnowledgeChatInput & {
  timings: AiKnowledgeChatTimingCollector;
};

export type AiChatThinkingStep =
  | 'understanding'
  | 'searching'
  | 'analyzing'
  | 'preparing'
  | 'fallback';

export type AiChatThinkingStatus =
  | 'started'
  | 'completed'
  | 'skipped'
  | 'failed';

export type AiChatThinkingStats = {
  historyMessageCount?: number;
  queryRewritten?: boolean;
  matchedChunkCount?: number;
  sourceCount?: number;
  includedItemCount?: number;
};

export type AiChatThinkingEvent = {
  step: AiChatThinkingStep;
  status: AiChatThinkingStatus;
  durationMs?: number;
  stats?: AiChatThinkingStats;
  outcome?: 'knowledge' | 'insufficient' | 'general';
};

export type AiKnowledgeChatTimings = {
  rewriteMs?: number;
  retrievalMs?: number;
  ttftMs?: number;
  generationMs?: number;
  totalMs: number;
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
    knowledgePageId: string;
    origin: KnowledgeRetrievalOrigin;
    authorizationMode: KnowledgeRetrievalAuthorizationMode;
    title: string;
    text: string;
    retrievalReasons: string[];
    sourceWindows: KnowledgeSourceWindow[];
  }>;
  warnings: ReturnType<
    KnowledgeContextPackService['buildContextPack']
  >['warnings'];
  budget: ReturnType<KnowledgeContextPackService['buildContextPack']>['budget'];
  completenessNotice: ReturnType<
    KnowledgeContextPackService['buildContextPack']
  >['completenessNotice'];
  retrieval?: KnowledgeRetrievalObservation;
  context?: KnowledgeContextObservation;
  retrievalDiagnostics?: KnowledgeRetrievalDiagnostics & {
    mode: ReturnType<KnowledgeRetrievalService['retrieve']> extends Promise<
      infer Result
    >
    ? Result extends { mode: infer Mode }
    ? Mode
    : never
    : never;
  };
  retrievalScope?: KnowledgeRetrievalScope;
  timings?: AiKnowledgeChatTimings;
  attachmentHitContext?: { directHitChunkIds: string[] };
  queryObservation: KnowledgeQueryObservation;
};

type AiKnowledgeRetrievedEvidence = {
  pack: ReturnType<KnowledgeContextPackService['buildContextPack']>;
  retrievedSources: AiKnowledgeChatResult['retrievedSources'];
};

export type KnowledgeQueryDecisionReason =
  | 'explicit_general'
  | 'raw_results_only'
  | 'no_knowledge_evidence'
  | 'model_general'
  | 'model_no_match'
  | 'knowledge'
  | 'generation_empty';

export type KnowledgeQueryObservation = {
  decisionReason: KnowledgeQueryDecisionReason;
  generalAnswerReason?: string;
  finalChunkIds: string[];
  finalSourcePageIds: string[];
  rankReasonsByChunk: Record<string, string[]>;
  contextItems: KnowledgeContextPackingItem[];
  packContextLength: number;
  packMaxContextLength: number;
  answerContextLength: number | null;
  answerContextHash: string | null;
};

export type AiKnowledgeRetrievalResult = {
  query: string;
  citations: ReturnType<
    KnowledgeContextPackService['buildContextPack']
  >['citations'];
  citationEvidence: AiKnowledgeCitationEvidence[];
  retrievedSources: ReturnType<
    KnowledgeContextPackService['buildContextPack']
  >['citations'];
  snippets: Array<{
    id: string;
    knowledgePageId: string;
    origin: KnowledgeRetrievalOrigin;
    authorizationMode: KnowledgeRetrievalAuthorizationMode;
    title: string;
    text: string;
    retrievalReasons: string[];
    sourceWindows: KnowledgeSourceWindow[];
  }>;
  warnings: ReturnType<
    KnowledgeContextPackService['buildContextPack']
  >['warnings'];
  budget: ReturnType<KnowledgeContextPackService['buildContextPack']>['budget'];
  completenessNotice: ReturnType<
    KnowledgeContextPackService['buildContextPack']
  >['completenessNotice'];
  retrievalDiagnostics: KnowledgeRetrievalDiagnostics & {
    mode: Awaited<ReturnType<KnowledgeRetrievalService['retrieve']>>['mode'];
  };
  retrievalScope: KnowledgeRetrievalScope;
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
  ) { }


  async retrieveOnly(input: {
    workspaceId: string;
    userId: string;
    supplementalUserId?: string;
    query: string;
    spaceIds: string[];
    workspace?: Workspace;
  }): Promise<AiKnowledgeRetrievalResult> {
    if (input.workspace && !this.isEnabledForWorkspace(input.workspace)) {
      throw new ForbiddenException(
        errorBody(
          ErrorCode.AI_KNOWLEDGE_DISABLED,
          'AI knowledge chat is disabled',
        ),
      );
    }

    const authCache = new KnowledgeAuthorizationCache({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const retrieval = await this.retrieval.retrieve({
      workspaceId: input.workspaceId,
      userId: input.userId,
      supplementalUserId: input.supplementalUserId,
      query: input.query,
      spaceIds: input.spaceIds,
      authCache,
    });
    const chunkCitations = retrieval.chunks.length
      ? await this.citationResolver.resolveForChunks({
        workspaceId: input.workspaceId,
        query: input.query,
        chunks: retrieval.chunks,
      })
      : undefined;
    // Keep the same precedence as chat(): chunk evidence is authoritative;
    // capsule citations are only resolved for capsule-only retrieval results.
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
    const sourceWindows = pack.primary.flatMap((entry) => entry.sourceWindows);
    const citations = pack.citations;

    return {
      query: input.query,
      citations,
      citationEvidence: buildCitationEvidence(citations, sourceWindows),
      retrievedSources: citations,
      snippets: pack.primary.map((entry) => ({
        id: entry.id,
        knowledgePageId: entry.knowledgePageId,
        origin: entry.origin,
        authorizationMode: entry.authorizationMode,
        title: entry.title,
        text: entry.text,
        retrievalReasons: entry.retrievalReasons,
        sourceWindows: entry.sourceWindows,
      })),
      warnings: pack.warnings,
      budget: pack.budget,
      completenessNotice: pack.completenessNotice,
      retrievalDiagnostics: {
        mode: retrieval.mode,
        ...retrieval.diagnostics,
      },
      retrievalScope: retrieval.scope,
    };
  }


  private recordFirstToken(
    input: TimedChatInput,
    generationStartedAt: number,
    attempt: 'knowledge' | 'general',
  ): void {
    input.timings.markFirstToken();
    input.debugTiming?.record(
      'generation.provider_first_token',
      performance.now() - generationStartedAt,
      { attempt },
    );
  }

  async chat(input: AiKnowledgeChatInput): Promise<AiKnowledgeChatResult> {
    if (input.workspace && !this.isEnabledForWorkspace(input.workspace)) {
      throw new ForbiddenException(
        errorBody(
          ErrorCode.AI_KNOWLEDGE_DISABLED,
          'AI knowledge chat is disabled',
        ),
      );
    }

    const timings = new AiKnowledgeChatTimingCollector();
    const result = await this.runChat({ ...input, timings });
    return input.collectTimings
      ? { ...result, timings: timings.snapshot() }
      : result;
  }

  private async runChat(input: TimedChatInput): Promise<AiKnowledgeChatResult> {
    const thinking = new AiChatThinkingProgress(input.onThinking);
    if (input.responseMode === 'general') {
      const { result: generalAnswer, generalAnswerReason } =
        await this.answerFromGeneralKnowledge(input, thinking, 'preparing');
      return {
        ...generalAnswer,
        attachmentHitContext: { directHitChunkIds: [] },
        retrieval: {
          attempted: false,
          candidates: [],
          dropped: [],
          topK: 0,
          threshold: 0.45,
        },
        context: emptyContextObservation(),
        queryObservation: emptyQueryObservation(
          'explicit_general',
          generalAnswerReason,
        ),
      };
    }


    const authCache = new KnowledgeAuthorizationCache({
      workspaceId: input.workspaceId,
      userId: input.userId,
      chatId: input.chatId,
    });

    if (input.contextPageId) {
      return this.answerFromAttachedPage(input, authCache, thinking);
    }

    thinking.start('understanding', {
      historyMessageCount: input.chatContext?.length ?? 0,
    });
    const retrievalQuery = await this.rewriteRetrievalQuery(input);
    const contextualRetrievalQuery =
      retrievalQuery.trim() !== input.query.trim() ? retrievalQuery : undefined;
    thinking.complete('understanding', {
      queryRewritten: Boolean(contextualRetrievalQuery),
    });
    input.onStage?.('retrieval');
    thinking.start('searching');
    const retrieval = await input.timings.measure('retrievalMs', () =>
      measureAiChatPhase(
        input.debugTiming,
        'retrieval.total',
        () =>
          this.retrieval.retrieve({
            workspaceId: input.workspaceId,
            userId: input.userId,
            supplementalUserId: input.supplementalUserId,
            query: retrievalQuery,
            spaceIds: input.spaceIds,
            ...(input.labelNames?.length
              ? { labelNames: input.labelNames }
              : {}),
            authCache,
            ...(input.scoreThreshold !== undefined
              ? { maxCosineDistance: input.scoreThreshold }
              : {}),
            ...(input.debugTiming ? { debugTiming: input.debugTiming } : {}),
          }),
        (result) => ({
          retrievalMode: result.mode,
          chunkCount: result.chunks.length,
          capsuleCount: result.capsules.length,
          embeddingAvailable:
            result.diagnostics?.queryEmbeddingAvailable ?? false,
          fallbackUsed: result.diagnostics?.accessPolicyFallbackUsed ?? false,
        }),
      ),
    );
    thinking.complete('searching', {
      matchedChunkCount:
        retrieval.diagnostics?.authorizedChunkCount ?? retrieval.chunks.length,
      sourceCount:
        retrieval.diagnostics?.finalAuthorizedSourceCount ??
        unique(
          retrieval.chunks.flatMap(
            (candidate) => candidate.sourcePageIds ?? [],
          ),
        ).length,
    });
    thinking.start('analyzing');
    const chunkCitations = retrieval.chunks.length
      ? await measureAiChatPhase(
        input.debugTiming,
        'citations.resolve_chunks',
        () =>
          this.citationResolver.resolveForChunks({
            workspaceId: input.workspaceId,
            query: retrievalQuery,
            chunks: retrieval.chunks,
            ...(input.debugTiming ? { debugTiming: input.debugTiming } : {}),
          }),
        (citations) => ({ resolvedChunkCount: citations.length }),
      )
      : undefined;
    const capsuleCitations =
      !chunkCitations && retrieval.capsules.length
        ? await measureAiChatPhase(
          input.debugTiming,
          'citations.resolve_capsules',
          () =>
            this.citationResolver.resolveForCapsules({
              workspaceId: input.workspaceId,
              userId: input.userId,
              capsules: retrieval.capsules,
              authCache,
              ...(input.debugTiming
                ? { debugTiming: input.debugTiming }
                : {}),
            }),
          (citations) => ({ resolvedCapsuleCount: citations.length }),
        )
        : undefined;
    const contextPackStartedAt = performance.now();
    const pack = this.contextPack.buildContextPack({
      chunks: chunkCitations,
      capsules: capsuleCitations,
    });
    const contextPackDurationMs = performance.now() - contextPackStartedAt;
    input.debugTiming?.record('context.build_pack', contextPackDurationMs, {
      includedItemCount: pack.budget.includedItemCount,
      contextChars: pack.budget.usedContextLength,
    });
    const explicit = await measureAiChatPhase(
      input.debugTiming,
      'context.load_explicit',
      () => this.loadExplicitContext(input, authCache),
      (result) => ({
        explicitContextChars: result.context.length,
        explicitCitationCount: result.citations.length,
        requestedPageCount:
          (input.contextPageId ? 1 : 0) + (input.mentionedPageIds?.length ?? 0),
        attachmentCount: input.attachmentIds?.length ?? 0,
      }),
    );
    const allCitations = uniqueCitations([
      ...explicit.citations,
      ...pack.citations,
    ]);
    const retrievalDiagnostics = {
      mode: retrieval.mode,
      ...retrieval.diagnostics,
    };
    const retrievalScope = retrieval.scope;
    const retrievalObservation = retrieval.retrievalObservation ?? {
      attempted: true,
      candidates: [],
      dropped: [],
      topK: 20,
      threshold: input.scoreThreshold ?? 0.45,
    };
    const baseObservation: KnowledgeQueryObservation = {
      decisionReason: 'knowledge',
      finalChunkIds: retrieval.chunks.map(retrievalChunkId),
      finalSourcePageIds: unique(
        retrieval.chunks.flatMap((candidate) => candidate.sourcePageIds ?? []),
      ),
      rankReasonsByChunk: Object.fromEntries(
        retrieval.chunks.map((candidate) => [
          retrievalChunkId(candidate),
          candidate.rankReasons ?? [],
        ]),
      ),
      contextItems: pack.packing?.items ?? [],
      packContextLength: pack.context.length,
      packMaxContextLength: pack.budget.maxContextLength,
      answerContextLength: null,
      answerContextHash: null,
    };
    // Carried on every normal return path below (§1.2: retrieval hits are
    // resolved by the hit set regardless of the answer branch).
    const attachmentHitContext = {
      directHitChunkIds: retrieval.directHitChunkIds,
    };
    const hasKnowledgeEvidence =
      explicit.context.trim().length > 0 ||
      pack.primary.some((entry) => entry.sourceWindows.length > 0);

    thinking.complete(
      'analyzing',
      {
        includedItemCount: pack.budget.includedItemCount,
        sourceCount: allCitations.length,
      },
      hasKnowledgeEvidence ? 'knowledge' : 'insufficient',
    );

    if (input.rawResultsOnly) {
      const rawSourceWindows = pack.primary.flatMap(
        (entry) => entry.sourceWindows,
      );
      return {
        answer: '',
        answerMode: hasKnowledgeEvidence ? 'knowledge' : 'no_match',
        ...(contextualRetrievalQuery
          ? { retrievalQuery: contextualRetrievalQuery }
          : {}),
        citations: allCitations,
        citationEvidence: buildCitationEvidence(allCitations, rawSourceWindows),
        retrievedSources: allCitations,
        snippets: pack.primary.map((entry) => ({
          id: entry.id,
          knowledgePageId: entry.knowledgePageId,
          origin: entry.origin,
          authorizationMode: entry.authorizationMode,
          title: entry.title,
          text: entry.text,
          retrievalReasons: entry.retrievalReasons,
          sourceWindows: entry.sourceWindows,
        })),
        warnings: pack.warnings,
        budget: pack.budget,
        completenessNotice: pack.completenessNotice,
        retrieval: retrievalObservation,
        context: buildContextObservation({
          pack,
          text: pack.context,
          explicitContext: '',
          retrievalObservation,
        }),
        retrievalDiagnostics,
        ...(retrievalScope ? { retrievalScope } : {}),
        attachmentHitContext,
        queryObservation: withDecision(baseObservation, 'raw_results_only'),
      };
    }

    if (!hasKnowledgeEvidence) {
      if (input.generalKnowledgeEnabled === false) {
        return {
          ...this.buildNoMatchResult(
            input.query,
            thinking,
            input.onToken,
            input.onStage,
          ),
          ...(contextualRetrievalQuery
            ? { retrievalQuery: contextualRetrievalQuery }
            : {}),
          retrievalDiagnostics,
          retrieval: retrievalObservation,
          context: emptyContextObservation(),
          ...(retrievalScope ? { retrievalScope } : {}),
          attachmentHitContext,
          queryObservation: withDecision(
            baseObservation,
            'no_knowledge_evidence',
          ),
        };
      }
      const { result: generalAnswer, generalAnswerReason } =
        await this.answerFromGeneralKnowledge(input, thinking, 'fallback', {
          pack,
          retrievedSources: allCitations,
        });
      return {
        ...generalAnswer,
        ...(contextualRetrievalQuery
          ? { retrievalQuery: contextualRetrievalQuery }
          : {}),
        retrievalDiagnostics,
        retrieval: retrievalObservation,
        context: emptyContextObservation(),
        ...(retrievalScope ? { retrievalScope } : {}),
        attachmentHitContext,
        queryObservation: withDecision(
          baseObservation,
          'no_knowledge_evidence',
          generalAnswerReason,
        ),
      };
    }

    const answerInput = {
      query: input.query,
      context: [explicit.context, buildAnswerContext(pack)]
        .filter(Boolean)
        .join('\n\n'),
      chatContext: input.chatContext,
    };
    const answerObservation: KnowledgeQueryObservation = {
      ...baseObservation,
      answerContextLength: answerInput.context.length,
      answerContextHash: hashContext(answerInput.context),
    };
    let rawAnswer = '';
    let generatedAnswer: ParsedGeneratedAnswer = {
      mode: 'knowledge',
      content: '',
      hasExplicitModeMarker: false,
    };
    const streamed = Boolean(this.answerProvider.stream);
    input.onStage?.('generation');
    thinking.start('preparing');
    input.timings.markGenerationStart();
    if (this.answerProvider.stream) {
      const streamRouter = new KnowledgeAnswerStreamRouter(input.onToken);
      const generationStartedAt = performance.now();
      await input.timings.measure('generationMs', () =>
        measureAiChatPhase(
          input.debugTiming,
          'generation.provider',
          async () => {
            for await (const token of this.answerProvider.stream!({
              ...answerInput,
              // Reported by the provider on its first token of any kind, so
              // this fires during the thinking block rather than after it.
              onFirstToken: () =>
                this.recordFirstToken(input, generationStartedAt, 'knowledge'),
            })) {
              rawAnswer += token;
              streamRouter.push(token);
            }
          },
          { attempt: 'knowledge', streamed: true },
        ),
      );
      streamRouter.finish();
      generatedAnswer = parseGeneratedAnswer(rawAnswer);
    } else {
      rawAnswer = await input.timings.measure('generationMs', () =>
        measureAiChatPhase(
          input.debugTiming,
          'generation.provider',
          () => this.answerProvider.answer(answerInput),
          { attempt: 'knowledge', streamed: false },
        ),
      );
      generatedAnswer = parseGeneratedAnswer(rawAnswer);
    }
    if (
      generatedAnswer.mode === 'no_match' ||
      generatedAnswer.mode === 'general'
    ) {
      thinking.complete('preparing', undefined, 'insufficient');
      if (input.generalKnowledgeEnabled === false) {
        return {
          ...this.buildNoMatchResult(
            input.query,
            thinking,
            input.onToken,
            input.onStage,
          ),
          ...(contextualRetrievalQuery
            ? { retrievalQuery: contextualRetrievalQuery }
            : {}),
          retrievalDiagnostics,
          retrieval: retrievalObservation,
          context: emptyContextObservation(),
          ...(retrievalScope ? { retrievalScope } : {}),
          attachmentHitContext,
          queryObservation: withDecision(
            answerObservation,
            generatedAnswer.mode === 'general'
              ? 'model_general'
              : 'model_no_match',
            generatedAnswer.generalAnswerReason,
          ),
        };
      }
      if (
        generatedAnswer.mode === 'general' &&
        generatedAnswer.generalAnswerReason &&
        generatedAnswer.content.trim()
      ) {
        const cleanGeneralAnswer =
          stripCitationMarkers(generatedAnswer.content) ||
          buildGenerationUnavailableAnswer(input.query);
        const disclaimer = buildGeneralKnowledgeDisclaimer(input.query);
        input.onToken?.(disclaimer);
        input.onToken?.(cleanGeneralAnswer);
        return {
          ...this.buildGeneralKnowledgeResult(input.query, cleanGeneralAnswer, {
            pack,
            retrievedSources: allCitations,
          }),
          ...(contextualRetrievalQuery
            ? { retrievalQuery: contextualRetrievalQuery }
            : {}),
          retrievalDiagnostics,
          retrieval: retrievalObservation,
          context: emptyContextObservation(),
          ...(retrievalScope ? { retrievalScope } : {}),
          attachmentHitContext,
          queryObservation: withDecision(
            answerObservation,
            'model_general',
            generatedAnswer.generalAnswerReason,
          ),
        };
      }
      const { result: generalAnswer, generalAnswerReason } =
        await this.answerFromGeneralKnowledge(
          {
            ...input,
            onStage: undefined,
          },
          thinking,
          'fallback',
          { pack, retrievedSources: allCitations },
        );
      return {
        ...generalAnswer,
        ...(contextualRetrievalQuery
          ? { retrievalQuery: contextualRetrievalQuery }
          : {}),
        retrievalDiagnostics,
        retrieval: retrievalObservation,
        context: emptyContextObservation(),
        ...(retrievalScope ? { retrievalScope } : {}),
        attachmentHitContext,
        queryObservation: withDecision(
          answerObservation,
          generatedAnswer.mode === 'general'
            ? 'model_general'
            : 'model_no_match',
          generatedAnswer.generalAnswerReason ?? generalAnswerReason,
        ),
      };
    }
    let cleanAnswer = stripCitationMarkers(generatedAnswer.content);
    if (!cleanAnswer) {
      cleanAnswer = buildGenerationUnavailableAnswer(input.query);
      input.onToken?.(cleanAnswer);
    } else if (!streamed) {
      input.onToken?.(cleanAnswer);
    }
    thinking.complete('preparing', undefined, 'knowledge');
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
        knowledgePageId: entry.knowledgePageId,
        origin: entry.origin,
        authorizationMode: entry.authorizationMode,
        title: entry.title,
        text: entry.text,
        retrievalReasons: entry.retrievalReasons,
        sourceWindows: entry.sourceWindows,
      })),
      warnings: pack.warnings,
      budget: pack.budget,
      completenessNotice: pack.completenessNotice,
      retrieval: retrievalObservation,
      context: buildContextObservation({
        pack,
        text: answerInput.context,
        explicitContext: explicit.context,
        retrievalObservation,
        chatContext: input.chatContext,
      }),
      retrievalDiagnostics,
      ...(retrievalScope ? { retrievalScope } : {}),
      attachmentHitContext,
      queryObservation: withDecision(
        answerObservation,
        generatedAnswer.content.trim() ? 'knowledge' : 'generation_empty',
      ),
    };
  }

  private async answerFromAttachedPage(
    input: TimedChatInput,
    authCache: KnowledgeAuthorizationCache,
    thinking: AiChatThinkingProgress,
  ): Promise<AiKnowledgeChatResult> {
    input.onStage?.('understanding');
    thinking.start('understanding', {
      historyMessageCount: input.chatContext?.length ?? 0,
    });
    thinking.complete('understanding', { queryRewritten: false });
    thinking.start('analyzing');

    const explicit = await measureAiChatPhase(
      input.debugTiming,
      'context.load_explicit',
      () => this.loadExplicitContext(input, authCache),
      (result) => ({
        explicitContextChars: result.context.length,
        explicitCitationCount: result.citations.length,
        requestedPageCount:
          (input.contextPageId ? 1 : 0) + (input.mentionedPageIds?.length ?? 0),
        attachmentCount: input.attachmentIds?.length ?? 0,
      }),
    );
    const pack = this.contextPack.buildContextPack({});
    const attachmentHitContext = { directHitChunkIds: [] as string[] };
    const hasKnowledgeEvidence = explicit.context.trim().length > 0;

    thinking.complete(
      'analyzing',
      {
        includedItemCount: explicit.citations.length,
        sourceCount: explicit.citations.length,
      },
      hasKnowledgeEvidence ? 'knowledge' : 'insufficient',
    );

    if (!hasKnowledgeEvidence) {
      if (input.generalKnowledgeEnabled === false) {
        return {
          ...this.buildNoMatchResult(
            input.query,
            thinking,
            input.onToken,
            input.onStage,
          ),
          attachmentHitContext,
          queryObservation: emptyQueryObservation('no_knowledge_evidence'),
        };
      }
      const { result: generalAnswer, generalAnswerReason } =
        await this.answerFromGeneralKnowledge(input, thinking, 'fallback');
      return {
        ...generalAnswer,
        attachmentHitContext,
        queryObservation: emptyQueryObservation(
          'no_knowledge_evidence',
          generalAnswerReason,
        ),
      };
    }

    const answerInput = {
      query: input.query,
      context: explicit.context,
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
    thinking.start('preparing');

    if (this.answerProvider.stream) {
      const streamRouter = new KnowledgeAnswerStreamRouter(input.onToken);
      const generationStartedAt = performance.now();
      let providerFirstTokenLogged = false;
      await measureAiChatPhase(
        input.debugTiming,
        'generation.provider',
        async () => {
          for await (const token of this.answerProvider.stream!({
            ...answerInput,
            onFirstToken: () => {
              if (providerFirstTokenLogged) return;
              providerFirstTokenLogged = true;
              input.debugTiming?.record(
                'generation.provider_first_token',
                performance.now() - generationStartedAt,
                { attempt: 'attached_page' },
              );
            },
          })) {
            rawAnswer += token;
            streamRouter.push(token);
          }
        },
        { attempt: 'attached_page', streamed: true },
      );
      streamRouter.finish();
      generatedAnswer = parseGeneratedAnswer(rawAnswer);
    } else {
      rawAnswer = await measureAiChatPhase(
        input.debugTiming,
        'generation.provider',
        () => this.answerProvider.answer(answerInput),
        { attempt: 'attached_page', streamed: false },
      );
      generatedAnswer = parseGeneratedAnswer(rawAnswer);
    }

    if (
      generatedAnswer.mode === 'no_match' ||
      generatedAnswer.mode === 'general'
    ) {
      thinking.complete('preparing', undefined, 'insufficient');
      const modelDecision =
        generatedAnswer.mode === 'general' ? 'model_general' : 'model_no_match';
      if (input.generalKnowledgeEnabled === false) {
        return {
          ...this.buildNoMatchResult(
            input.query,
            thinking,
            input.onToken,
            input.onStage,
          ),
          attachmentHitContext,
          queryObservation: emptyQueryObservation(modelDecision),
        };
      }
      const { result: generalAnswer, generalAnswerReason } =
        await this.answerFromGeneralKnowledge(
          { ...input, onStage: undefined },
          thinking,
          'fallback',
        );
      return {
        ...generalAnswer,
        attachmentHitContext,
        queryObservation: emptyQueryObservation(
          modelDecision,
          generalAnswerReason,
        ),
      };
    }

    let cleanAnswer = stripCitationMarkers(generatedAnswer.content);
    if (!cleanAnswer) {
      cleanAnswer = buildGenerationUnavailableAnswer(input.query);
      input.onToken?.(cleanAnswer);
    } else if (!streamed) {
      input.onToken?.(cleanAnswer);
    }
    thinking.complete('preparing', undefined, 'knowledge');

    const citations = resolveAnswerCitations(
      explicit.citations,
      generatedAnswer.hasExplicitModeMarker
        ? extractCitedSourceIds(rawAnswer)
        : new Set<string>(),
      [],
      explicit.citations.map((citation) => citation.sourcePageId),
    );

    return {
      answer: cleanAnswer,
      answerMode: 'knowledge',
      citations,
      citationEvidence: buildCitationEvidence(citations, []),
      retrievedSources: explicit.citations,
      snippets: [],
      warnings: pack.warnings,
      budget: pack.budget,
      completenessNotice: pack.completenessNotice,
      attachmentHitContext,
      queryObservation: withDecision(
        emptyQueryObservation('knowledge'),
        cleanAnswer.trim() ? 'knowledge' : 'generation_empty',
      ),
    };
  }

  isEnabledForWorkspace(workspace: Workspace): boolean {
    return isKnowledgeAiEnabledForWorkspace(workspace);
  }

  private async answerFromGeneralKnowledge(
    input: TimedChatInput,
    thinking = new AiChatThinkingProgress(input.onThinking),
    thinkingStep: Extract<
      AiChatThinkingStep,
      'preparing' | 'fallback'
    > = 'preparing',
    retrievedEvidence?: AiKnowledgeRetrievedEvidence,
  ): Promise<{
    result: Omit<AiKnowledgeChatResult, 'queryObservation'>;
    generalAnswerReason?: string;
  }> {
    const answerInput: KnowledgeAnswerProviderInput = {
      query: input.query,
      context: '',
      chatContext: input.chatContext,
      mode: 'general',
    };
    const disclaimer = buildGeneralKnowledgeDisclaimer(input.query);
    let generatedAnswer = '';

    input.onStage?.('generation');
    thinking.start(thinkingStep);
    input.onToken?.(disclaimer);
    input.timings.markGenerationStart();
    const streamed = Boolean(this.answerProvider.stream);
    if (this.answerProvider.stream) {
      const sanitizer = new GeneralReasonStreamFilter(input.onToken);
      const generationStartedAt = performance.now();
      await input.timings.measure('generationMs', () =>
        measureAiChatPhase(
          input.debugTiming,
          'generation.provider',
          async () => {
            for await (const token of this.answerProvider.stream!({
              ...answerInput,
              onFirstToken: () =>
                this.recordFirstToken(input, generationStartedAt, 'general'),
            })) {
              generatedAnswer += token;
              sanitizer.push(token);
            }
          },
          { attempt: 'general', streamed: true },
        ),
      );
      sanitizer.finish();
    } else {
      generatedAnswer = await input.timings.measure('generationMs', () =>
        measureAiChatPhase(
          input.debugTiming,
          'generation.provider',
          () => this.answerProvider.answer(answerInput),
          { attempt: 'general', streamed: false },
        ),
      );
    }

    const parsedGeneralAnswer = parseGeneralAnswerOutput(generatedAnswer);
    const cleanAnswer =
      stripCitationMarkers(parsedGeneralAnswer.content) ||
      buildGenerationUnavailableAnswer(input.query);
    if (!streamed || !generatedAnswer.trim()) {
      input.onToken?.(cleanAnswer);
    }

    thinking.complete(thinkingStep, undefined, 'general');

    return {
      result: this.buildGeneralKnowledgeResult(
        input.query,
        cleanAnswer,
        retrievedEvidence,
      ),
      ...(parsedGeneralAnswer.reason
        ? { generalAnswerReason: parsedGeneralAnswer.reason }
        : {}),
    };
  }

  private buildGeneralKnowledgeResult(
    query: string,
    cleanAnswer: string,
    retrievedEvidence?: AiKnowledgeRetrievedEvidence,
  ): Omit<AiKnowledgeChatResult, 'queryObservation'> {
    const pack =
      retrievedEvidence?.pack ?? this.contextPack.buildContextPack({});
    return {
      answer: `${buildGeneralKnowledgeDisclaimer(query)}${cleanAnswer}`,
      answerMode: 'general',
      citations: [],
      citationEvidence: [],
      retrievedSources: retrievedEvidence?.retrievedSources ?? [],
      snippets: retrievedEvidence
        ? pack.primary.map((entry) => ({
          id: entry.id,
          knowledgePageId: entry.knowledgePageId,
          origin: entry.origin,
          authorizationMode: entry.authorizationMode,
          title: entry.title,
          text: entry.text,
          retrievalReasons: entry.retrievalReasons,
          sourceWindows: entry.sourceWindows,
        }))
        : [],
      warnings: pack.warnings,
      budget: pack.budget,
      completenessNotice: pack.completenessNotice,
    };
  }

  private buildNoMatchResult(
    query: string,
    thinking: AiChatThinkingProgress,
    onToken?: (token: string) => void,
    onStage?: (stage: 'understanding' | 'retrieval' | 'generation') => void,
  ): Omit<AiKnowledgeChatResult, 'queryObservation'> {
    const pack = this.contextPack.buildContextPack({});
    const answer = buildKnowledgeNoMatchAnswer(query);
    onStage?.('generation');
    thinking.start('fallback');
    onToken?.(answer);
    thinking.complete('fallback', undefined, 'insufficient');
    return {
      answer,
      answerMode: 'no_match',
      citations: [],
      citationEvidence: [],
      retrievedSources: [],
      snippets: [],
      warnings: pack.warnings,
      budget: pack.budget,
      completenessNotice: pack.completenessNotice,
    };
  }

  private async rewriteRetrievalQuery(input: TimedChatInput): Promise<string> {
    if (input.queryRewriteEnabled === false) {
      input.debugTiming?.mark('context.rewrite_skipped', {
        reason: 'disabled_by_request',
      });
      return input.query;
    }
    if (!input.chatContext?.length || !this.answerProvider.rewriteQuery) {
      input.debugTiming?.mark('context.rewrite_skipped', {
        reason: !input.chatContext?.length
          ? 'no_history'
          : 'provider_not_configured',
      });
      return input.query;
    }

    input.onStage?.('understanding');
    try {
      const rewritten = await input.timings.measure('rewriteMs', () =>
        measureAiChatPhase(
          input.debugTiming,
          'context.rewrite',
          () =>
            this.answerProvider.rewriteQuery!({
              query: input.query,
              chatContext: input.chatContext!,
            }),
          {
            historyMessageCount: input.chatContext!.length,
            historyChars: input.chatContext!.join('\n').length,
          },
        ),
      );
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
      const readablePageIds = await measureAiChatPhase(
        input.debugTiming,
        'context.authorize_explicit_pages',
        () =>
          this.sourceAuthorization!.filterReadableSources({
            workspaceId: input.workspaceId,
            userId: input.userId,
            supplementalUserId: input.supplementalUserId,
            sourcePageIds: requestedPageIds,
            cache: authCache,
          }),
        (result) => ({
          requestedPageCount: requestedPageIds.length,
          readablePageCount: result.length,
        }),
      );
      const pages = await measureAiChatPhase(
        input.debugTiming,
        'context.load_explicit_pages',
        () =>
          this.pageRepo!.findManyByIds(readablePageIds, {
            workspaceId: input.workspaceId,
            includeTextContent: true,
          }),
        (result) => ({ loadedPageCount: result.length }),
      );
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
      const uniqueAttachmentIds = unique(input.attachmentIds);
      const attachments = await measureAiChatPhase(
        input.debugTiming,
        'context.load_attachments',
        () =>
          Promise.all(
            uniqueAttachmentIds.map((id) =>
              this.attachmentRepo!.findByIdWithContent(id),
            ),
          ),
        (result) => ({
          requestedAttachmentCount: uniqueAttachmentIds.length,
          loadedAttachmentCount: result.filter(Boolean).length,
        }),
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

export function isGeneralKnowledgeEnabledForUser(user: User): boolean {
  const settings = user.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return true;
  }
  const preferences = (settings as Record<string, unknown>).preferences;
  if (
    !preferences ||
    typeof preferences !== 'object' ||
    Array.isArray(preferences)
  ) {
    return true;
  }
  return (preferences as Record<string, unknown>).generalKnowledge !== false;
}

type TimedPhase = 'rewriteMs' | 'retrievalMs' | 'generationMs';

class AiKnowledgeChatTimingCollector {
  private readonly startedAt = performance.now();
  private readonly phases: Partial<Record<TimedPhase, number>> = {};
  private generationStartedAt?: number;
  private firstTokenAt?: number;

  record(phase: TimedPhase, durationMs: number): void {
    this.phases[phase] = roundDuration((this.phases[phase] ?? 0) + durationMs);
  }

  async measure<T>(phase: TimedPhase, operation: () => Promise<T>): Promise<T> {
    const phaseStartedAt = performance.now();
    try {
      return await operation();
    } finally {
      this.record(phase, performance.now() - phaseStartedAt);
    }
  }

  markGenerationStart(): void {
    this.generationStartedAt ??= performance.now();
  }

  markFirstToken(): void {
    this.firstTokenAt ??= performance.now();
  }

  snapshot(): AiKnowledgeChatTimings {
    const ttftMs =
      this.firstTokenAt === undefined || this.generationStartedAt === undefined
        ? undefined
        : roundDuration(this.firstTokenAt - this.generationStartedAt);
    return {
      ...this.phases,
      ...(ttftMs === undefined ? {} : { ttftMs }),
      totalMs: roundDuration(performance.now() - this.startedAt),
    };
  }
}

class AiChatThinkingProgress {
  private readonly startedAt = new Map<AiChatThinkingStep, number>();
  private readonly startedStats = new Map<
    AiChatThinkingStep,
    AiChatThinkingStats
  >();

  constructor(private readonly emit?: (event: AiChatThinkingEvent) => void) { }

  start(step: AiChatThinkingStep, stats?: AiChatThinkingStats): void {
    this.startedAt.set(step, performance.now());
    if (stats) this.startedStats.set(step, stats);
    this.emit?.({
      step,
      status: 'started',
      ...(stats ? { stats } : {}),
    });
  }

  complete(
    step: AiChatThinkingStep,
    stats?: AiChatThinkingStats,
    outcome?: AiChatThinkingEvent['outcome'],
  ): void {
    const startedAt = this.startedAt.get(step);
    const mergedStats = {
      ...this.startedStats.get(step),
      ...stats,
    };
    this.startedAt.delete(step);
    this.startedStats.delete(step);
    this.emit?.({
      step,
      status: 'completed',
      ...(startedAt === undefined
        ? {}
        : { durationMs: roundDuration(performance.now() - startedAt) }),
      ...(Object.keys(mergedStats).length ? { stats: mergedStats } : {}),
      ...(outcome ? { outcome } : {}),
    });
  }
}

function roundDuration(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
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
  generalAnswerReason?: string;
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

function emptyQueryObservation(
  decisionReason: KnowledgeQueryDecisionReason,
  generalAnswerReason?: string,
): KnowledgeQueryObservation {
  return {
    decisionReason,
    ...(generalAnswerReason ? { generalAnswerReason } : {}),
    finalChunkIds: [],
    finalSourcePageIds: [],
    rankReasonsByChunk: {},
    contextItems: [],
    packContextLength: 0,
    packMaxContextLength: 0,
    answerContextLength: null,
    answerContextHash: null,
  };
}

function withDecision(
  observation: KnowledgeQueryObservation,
  decisionReason: KnowledgeQueryDecisionReason,
  generalAnswerReason?: string,
): KnowledgeQueryObservation {
  return {
    ...observation,
    decisionReason,
    ...(generalAnswerReason ? { generalAnswerReason } : {}),
  };
}

function hashContext(context: string): string {
  return `sha256:${createHash('sha256').update(context).digest('hex')}`;
}

function retrievalChunkId(
  candidate: Awaited<
    ReturnType<KnowledgeRetrievalService['retrieve']>
  >['chunks'][number],
): string {
  return candidate.chunk?.id ?? (candidate as unknown as { id: string }).id;
}

function emptyContextObservation(): KnowledgeContextObservation {
  return { text: '', items: [], usedTokens: 0, maxTokens: 0, dropped: [] };
}

function buildContextObservation(input: {
  pack: ReturnType<KnowledgeContextPackService['buildContextPack']>;
  text: string;
  explicitContext: string;
  retrievalObservation?: KnowledgeRetrievalObservation;
  chatContext?: string[];
}): KnowledgeContextObservation {
  const items = input.pack.primary.flatMap((entry) =>
    (entry.citationSourcePageIds.length
      ? entry.citationSourcePageIds
      : [entry.id]
    ).map((pageId) => ({
      itemId: entry.id,
      pageId,
      text: entry.text,
      tokenCount: estimateTokenCount(entry.text),
    })),
  );
  const dropped = (input.pack.packing?.items ?? []).flatMap((item) => {
    if (item.disposition === 'included') return [];
    const pageIds = item.sourcePageIds?.length
      ? item.sourcePageIds
      : [item.itemId];
    const reason =
      item.disposition === 'clipped'
        ? 'clipped_by_context_budget'
        : 'context_budget';
    return pageIds.map((pageId) => ({
      itemId: item.itemId,
      pageId,
      reason,
    }));
  });
  const retrievalDropped = (input.retrievalObservation?.dropped ?? []).map(
    (candidate) => ({
      itemId: candidate.chunkId,
      pageId: candidate.pageId,
      reason: candidate.reason,
    }),
  );
  const droppedById = new Map(
    [...dropped, ...retrievalDropped].map((item) => [
      `${item.itemId}:${item.pageId}:${item.reason}`,
      item,
    ]),
  );
  if (input.explicitContext.trim()) {
    items.unshift({
      itemId: 'explicit-context',
      pageId: 'explicit-context',
      text: input.explicitContext,
      tokenCount: estimateTokenCount(input.explicitContext),
    });
  }
  const nonKnowledgeContext = [
    ...(input.chatContext ?? []),
    input.explicitContext,
  ]
    .filter(Boolean)
    .join('\n\n');
  const observedContext = [nonKnowledgeContext, input.text]
    .filter(Boolean)
    .join('\n\n');
  const maxContextChars =
    input.pack.budget.maxContextLength +
    nonKnowledgeContext.length +
    (nonKnowledgeContext ? 2 : 0);
  return {
    text: input.text,
    items,
    usedTokens: estimateTokenCount(observedContext),
    maxTokens: Math.ceil(maxContextChars / 4),
    dropped: [...droppedById.values()],
  };
}

function estimateTokenCount(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
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
  const parsedContent = parseGeneralAnswerOutput(
    content.slice(matchedMode.marker.length).trimStart(),
  );
  return {
    mode: matchedMode.mode,
    content: parsedContent.content,
    hasExplicitModeMarker: true,
    ...(matchedMode.mode === 'general' && parsedContent.reason
      ? { generalAnswerReason: parsedContent.reason }
      : {}),
  };
}

const GENERAL_REASON_PATTERN = /<general_reason>([\s\S]*?)<\/general_reason>/i;
const GENERAL_REASON_OPEN = '<general_reason>';
const GENERAL_REASON_CLOSE = '</general_reason>';

function parseGeneralAnswerOutput(answer: string): {
  content: string;
  reason?: string;
} {
  const match = answer.match(GENERAL_REASON_PATTERN);
  const reason = match?.[1]?.replace(/\s+/g, ' ').trim().slice(0, 2_000);
  const content = answer
    .replace(GENERAL_REASON_PATTERN, '')
    .replace(/<\/?general_reason>/gi, '')
    .trimStart();
  return {
    content,
    ...(reason ? { reason } : {}),
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

function buildKnowledgeNoMatchAnswer(query: string): string {
  if (/\p{Script=Han}/u.test(query)) {
    return '未检索到可用的知识库内容。请调整问题描述、补充更多上下文、选择其他知识空间，或开启通用知识模式后重试。';
  }

  return 'No usable knowledge was found. Try rephrasing the question, adding more context, choosing another knowledge space, or enabling general knowledge mode.';
}

class CitationStreamSanitizer {
  private buffer = '';

  constructor(private readonly emit?: (token: string) => void) { }

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

class GeneralReasonStreamFilter {
  private buffer = '';
  private resolved = false;
  private readonly sanitizer: CitationStreamSanitizer;

  constructor(emit?: (token: string) => void) {
    this.sanitizer = new CitationStreamSanitizer(emit);
  }

  push(token: string): void {
    if (this.resolved) {
      this.sanitizer.push(token);
      return;
    }

    this.buffer += token;
    const content = this.buffer.trimStart();
    if (!content) return;

    const lower = content.toLowerCase();
    const closeIndex = lower.indexOf(GENERAL_REASON_CLOSE);
    if (closeIndex >= 0) {
      this.resolve(
        content.slice(closeIndex + GENERAL_REASON_CLOSE.length).trimStart(),
      );
      return;
    }
    if (
      lower.startsWith(GENERAL_REASON_OPEN) ||
      GENERAL_REASON_OPEN.startsWith(lower)
    ) {
      return;
    }

    this.resolve(content);
  }

  finish(): void {
    if (!this.resolved) {
      this.resolve(parseGeneralAnswerOutput(this.buffer).content);
    }
    this.sanitizer.finish();
  }

  private resolve(content: string): void {
    this.resolved = true;
    this.buffer = '';
    if (content) this.sanitizer.push(content);
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
