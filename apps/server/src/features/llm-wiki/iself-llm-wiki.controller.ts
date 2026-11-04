import {
  ForbiddenException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Optional,
  Post,
  UseGuards,
  Body,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { User, Workspace } from '@akasha/db/types/entity.types';
import { KnowledgeQueryAuditRepo } from '@akasha/db/repos/llm-wiki/knowledge-query-audit.repo';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  IAuditService,
  AUDIT_SERVICE,
} from '../../integrations/audit/audit.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { QueryKnowledgeDto } from './dto/query-knowledge.dto';
import {
  AiKnowledgeChatService,
  AiKnowledgeChatResult,
} from './services/ai-knowledge-chat.service';
import { KnowledgeCitationImageResolverService } from './services/knowledge-citation-image-resolver.service';
import { KnowledgeCitationAttachmentResolverService } from './services/knowledge-citation-attachment-resolver.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AgentCallable } from '../../common/decorators/agent-callable.decorator';
import { AgentCapability } from '../../common/auth/agent-capability';
import { AuthCredentials } from '../../common/decorators/auth-credentials.decorator';
import { AuthCredentialPolicy } from '../../common/auth/auth-credential-policy';
import { AgentAccess } from '../../common/decorators/agent-access.decorator';
import type { AgentAccessContext } from '../../common/auth/agent-access-context';
import { buildKnowledgeQueryAuditMetadata } from './services/knowledge-query-audit-metadata';
import { AgentAccessService } from '../../core/page/page-access/agent-access.service';
import { ErrorCode, errorBody } from '../../common/errors/error-codes';

/** HTTP boundary for iself agents, with the same knowledge-chat behavior as the regular API. */
@UseGuards(JwtAuthGuard)
@Controller('iself/llm-wiki')
export class IsElfLlmWikiController {
  private readonly logger = new Logger(IsElfLlmWikiController.name);

  constructor(
    private readonly chatService: AiKnowledgeChatService,
    private readonly citationImageResolver: KnowledgeCitationImageResolverService,
    private readonly queryAuditRepo: KnowledgeQueryAuditRepo,
    private readonly agentAccessService: AgentAccessService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    @Optional() private readonly environmentService?: EnvironmentService,
    @Optional()
    private readonly attachmentResolver?: KnowledgeCitationAttachmentResolverService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('query')
  @AgentCallable(AgentCapability.KNOWLEDGE_QUERY)
  @AuthCredentials(AuthCredentialPolicy.AGENT_AND_SSO)
  async queryKnowledge(
    @Body() dto: QueryKnowledgeDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @AgentAccess() agentAccess: AgentAccessContext,
  ) {
    this.logger.log(
      `iself knowledge query: workspace=${workspace.id} user=${user.id} ` +
        `query=${JSON.stringify(dto.query)} body=${JSON.stringify(dto)}`,
    );

    if (!this.chatService.isEnabledForWorkspace(workspace)) {
      throw new ForbiddenException(
        errorBody(
          ErrorCode.AI_KNOWLEDGE_DISABLED,
          'AI knowledge chat is disabled',
        ),
      );
    }

    const allowedSpaceIds = new Set(
      await this.agentAccessService.getBoundSpaceIds(agentAccess),
    );
    const unauthorizedSpaceIds = dto.spaceIds.filter(
      (spaceId) => !allowedSpaceIds.has(spaceId),
    );
    if (unauthorizedSpaceIds.length > 0) {
      throw new ForbiddenException(
        'Requested Spaces are outside the Public API key scope',
      );
    }

    const result = await this.chatService.chat({
      workspaceId: workspace.id,
      userId: user.id,
      supplementalUserId: agentAccess.delegatedUser!.id,
      query: dto.query,
      spaceIds: dto.spaceIds,
      ...(dto.labels?.length ? { labelNames: dto.labels } : {}),
      chatContext: dto.chatContext,
      workspace,
      // iself is intentionally fail-closed for general knowledge. The caller
      // must opt in per request; the user's UI preference does not override
      // this agent-facing default.
      generalKnowledgeEnabled: dto.generalKnowledgeEnabled === true,
      ...(dto.scoreThreshold !== undefined
        ? { scoreThreshold: dto.scoreThreshold }
        : {}),
      ...(dto.rawResultsOnly === true ? { rawResultsOnly: true } : {}),
      ...(dto.queryRewriteEnabled !== undefined
        ? { queryRewriteEnabled: dto.queryRewriteEnabled }
        : {}),
    });
    const queryHash = hashQuery(dto.query);
    // Strip internal-only fields so they never leak through `...response`.
    const {
      retrievalDiagnostics,
      retrievalScope,
      attachmentHitContext,
      queryObservation,
      retrieval,
      context,
      ...response
    } = result;
    const requestedSpaceIds = retrievalScope?.requestedSpaceIds ?? dto.spaceIds;
    const effectiveSpaceIds =
      retrievalScope?.effectiveSpaceIds ?? requestedSpaceIds;
    const publicScopeValidated = true;

    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_QUERY,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: workspace.id,
      metadata: {
        origin: 'iself_knowledge_query',
        queryHash,
        spaceIds: dto.spaceIds,
        ...(dto.labels?.length ? { labelCount: dto.labels.length } : {}),
        requestedSpaceIds,
        effectiveSpaceIds,
        publicScopeValidated,
        publicApiKeyId: agentAccess.apiKeyId,
        citationCount: response.citations.length,
      },
    });

    await this.queryAuditRepo.recordQuery({
      workspaceId: workspace.id,
      userId: user.id,
      queryHash,
      retrievalMode: retrievalDiagnostics?.mode ?? 'general',
      authorizedCapsuleCount: retrievalDiagnostics?.authorizedChunkCount ?? 0,
      metadata: {
        origin: 'iself_knowledge_query',
        answerMode: response.answerMode,
        spaceIds: dto.spaceIds,
        ...(dto.labels?.length ? { labelCount: dto.labels.length } : {}),
        requestedSpaceIds,
        effectiveSpaceIds,
        publicScopeValidated,
        publicApiKeyId: agentAccess.apiKeyId,
        ...buildKnowledgeQueryAuditMetadata({
          answerMode: response.answerMode,
          queryObservation,
          retrievalDiagnostics,
          retrieval,
          context,
        }),
      },
    });

    const citationsWithImages = await this.resolveCitationImages({
      workspaceId: workspace.id,
      answer: response.answer,
      citations: response.citations,
      citationEvidence: response.citationEvidence,
    });
    // Top-level attachments are gated strictly by `attachments: true`;
    // `includeCitations` only controls citations (§8.1).
    const attachments =
      dto.attachments === true
        ? await this.resolveAttachments({
            workspaceId: workspace.id,
            directHitChunkIds: attachmentHitContext?.directHitChunkIds ?? [],
          })
        : undefined;
    const appUrl = this.environmentService?.getAppUrl();
    return {
      ...response,
      citations: mapCitationUrls(citationsWithImages, appUrl),
      ...(attachments ? { attachments } : {}),
      ...(Array.isArray(response.citationEvidence)
        ? {
            citationEvidence: mapCitationUrls(
              response.citationEvidence,
              appUrl,
            ),
          }
        : {}),
      ...(Array.isArray(response.retrievedSources)
        ? {
            retrievedSources: mapCitationUrls(
              response.retrievedSources,
              appUrl,
            ),
          }
        : {}),
      ...(Array.isArray(response.snippets)
        ? {
            snippets: response.snippets.map((snippet) => ({
              ...snippet,
              ...(Array.isArray(snippet.sourceWindows)
                ? {
                    sourceWindows: mapCitationUrls(
                      snippet.sourceWindows,
                      appUrl,
                    ),
                  }
                : {}),
            })),
          }
        : {}),
    };
  }

  private async resolveCitationImages(input: {
    workspaceId: string;
    answer: string;
    citations: AiKnowledgeChatResult['citations'];
    citationEvidence: AiKnowledgeChatResult['citationEvidence'];
  }): Promise<AiKnowledgeChatResult['citations']> {
    const emptyImages = () =>
      input.citations.map((citation) => ({ ...citation, images: [] }));

    try {
      return await this.citationImageResolver.resolveImagesForCitations({
        workspaceId: input.workspaceId,
        citations: input.citations,
        citationEvidence: input.citationEvidence,
        answerText: input.answer,
      });
    } catch (err) {
      this.logger.error(
        `Citation image resolution failed for workspace ${input.workspaceId}; ` +
          `degrading ${input.citations.length} citation(s) to images: []`,
        err instanceof Error ? err.stack : undefined,
      );
      return emptyImages();
    }
  }

  private async resolveAttachments(input: {
    workspaceId: string;
    directHitChunkIds: string[];
  }) {
    if (!this.attachmentResolver) return [];
    try {
      return await this.attachmentResolver.resolveAttachments(input);
    } catch (error) {
      this.logger.error(
        `Attachment resolution failed for workspace ${input.workspaceId}; ` +
          'returning attachments: []',
        error instanceof Error ? error.stack : undefined,
      );
      return [];
    }
  }
}

function hashQuery(query: string): string {
  return `sha256:${createHash('sha256').update(query).digest('hex')}`;
}

function mapCitationUrls<T extends { url: string }>(
  citations: readonly T[],
  appUrl?: string,
): T[] {
  return citations.map((citation) => ({
    ...citation,
    url: toAppCitationUrl(citation.url, appUrl),
  }));
}

function toAppCitationUrl(url: string, appUrl?: string): string {
  if (!appUrl || !url.startsWith('/')) return url;
  return `${appUrl.replace(/\/+$/, '')}${url}`;
}
