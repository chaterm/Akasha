import {
  ForbiddenException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Optional,
  Post,
  UnauthorizedException,
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
import { ApiKeyService } from '../api-key/api-key.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { QueryKnowledgeDto } from './dto/query-knowledge.dto';
import {
  AiKnowledgeChatService,
  AiKnowledgeChatResult,
} from './services/ai-knowledge-chat.service';
import { KnowledgeCitationImageResolverService } from './services/knowledge-citation-image-resolver.service';
import { KnowledgeCitationAttachmentResolverService } from './services/knowledge-citation-attachment-resolver.service';
import { IsElfAgentAuthGuard } from './guards/iself-agent-auth.guard';

/** HTTP boundary for iself agents, with the same knowledge-chat behavior as the regular API. */
@UseGuards(IsElfAgentAuthGuard)
@Controller('iself/llm-wiki')
export class IsElfLlmWikiController {
  private readonly logger = new Logger(IsElfLlmWikiController.name);

  constructor(
    private readonly chatService: AiKnowledgeChatService,
    private readonly citationImageResolver: KnowledgeCitationImageResolverService,
    private readonly queryAuditRepo: KnowledgeQueryAuditRepo,
    private readonly apiKeyService: ApiKeyService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    @Optional() private readonly environmentService?: EnvironmentService,
    @Optional()
    private readonly attachmentResolver?: KnowledgeCitationAttachmentResolverService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('query')
  async queryKnowledge(
    @Body() dto: QueryKnowledgeDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Headers('x-akasha-public-key') publicApiKey?: string,
  ) {
    if (!this.chatService.isEnabledForWorkspace(workspace)) {
      throw new ForbiddenException('AI knowledge chat is disabled');
    }

    if (!publicApiKey) {
      throw new UnauthorizedException('Public API key is required');
    }

    const publicAccess = await this.apiKeyService.validatePublicApiKey(
      publicApiKey,
      workspace.id,
    );
    const allowedSpaceIds = new Set(publicAccess.spaceIds);
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
      query: dto.query,
      spaceIds: dto.spaceIds,
      chatContext: dto.chatContext,
      workspace,
      // iself is intentionally fail-closed for general knowledge. The caller
      // must opt in per request; the user's UI preference does not override
      // this agent-facing default.
      generalKnowledgeEnabled: dto.generalKnowledgeEnabled === true,
      ...(dto.scoreThreshold !== undefined
        ? { scoreThreshold: dto.scoreThreshold }
        : {}),
    });
    const queryHash = hashQuery(dto.query);
    const { retrievalDiagnostics, retrievalScope, ...response } = result;
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
        requestedSpaceIds,
        effectiveSpaceIds,
        publicScopeValidated,
        publicApiKeyId: publicAccess.apiKeyId,
        citationCount: response.citations.length,
      },
    });

    await this.queryAuditRepo.recordQuery({
      workspaceId: workspace.id,
      userId: user.id,
      queryHash,
      retrievalMode: retrievalDiagnostics.mode,
      authorizedCapsuleCount: retrievalDiagnostics.authorizedChunkCount,
      metadata: {
        origin: 'iself_knowledge_query',
        spaceIds: dto.spaceIds,
        requestedSpaceIds,
        effectiveSpaceIds,
        publicScopeValidated,
        publicApiKeyId: publicAccess.apiKeyId,
        queryEmbeddingAvailable: retrievalDiagnostics.queryEmbeddingAvailable,
        candidateSourceCount: retrievalDiagnostics.candidateSourceCount,
        policyCandidateSourceCount:
          retrievalDiagnostics.policyCandidateSourceCount,
        fallbackCandidateSourceCount:
          retrievalDiagnostics.fallbackCandidateSourceCount,
        finalAuthorizedSourceCount:
          retrievalDiagnostics.finalAuthorizedSourceCount,
        accessPolicyFallbackUsed: retrievalDiagnostics.accessPolicyFallbackUsed,
        candidateChunkCount: retrievalDiagnostics.candidateChunkCount,
        rankedCandidateCount: retrievalDiagnostics.rankedCandidateCount,
        authorizedChunkCount: retrievalDiagnostics.authorizedChunkCount,
        filteredChunkCount: retrievalDiagnostics.filteredChunkCount,
      },
    });

    const citationsWithImages = await this.resolveCitationImages({
      workspaceId: workspace.id,
      answer: response.answer,
      citations: response.citations,
      citationEvidence: response.citationEvidence,
    });
    const attachments =
      dto.attachments === true || dto.includeCitations === true
        ? await this.resolveAttachments({
            workspaceId: workspace.id,
            citations: response.citations,
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
    citations: AiKnowledgeChatResult['citations'];
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
