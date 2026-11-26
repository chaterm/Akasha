import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { User, Workspace } from '@akasha/db/types/entity.types';
import { KnowledgeQueryAuditRepo } from '@akasha/db/repos/llm-wiki/knowledge-query-audit.repo';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import {
  IAuditService,
  AUDIT_SERVICE,
} from '../../../integrations/audit/audit.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  QueryKnowledgeDto,
  KnowledgeQueryType,
} from '../dto/query-knowledge.dto';
import {
  AiKnowledgeChatService,
  AiKnowledgeChatResult,
  isGeneralKnowledgeEnabledForUser,
} from './ai-knowledge-chat.service';
import { KnowledgeCitationImageResolverService } from './knowledge-citation-image-resolver.service';
import { KnowledgeCitationAttachmentResolverService } from './knowledge-citation-attachment-resolver.service';
import type { AgentAccessContext } from '../../../common/auth/agent-access-context';
import { buildKnowledgeQueryAuditMetadata } from './knowledge-query-audit-metadata';
import { AgentAccessService } from '../../../core/page/page-access/agent-access.service';
import { ErrorCode, errorBody } from '../../../common/errors/error-codes';

import { getApiKeyAccess } from '../../../common/auth/api-key-access';
import { ApiKeyType } from '../../../common/auth/api-key-type';

@Injectable()
export class KnowledgeQueryService {
  private readonly logger = new Logger(KnowledgeQueryService.name);

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

  async query(
    dto: QueryKnowledgeDto,
    user: User,
    workspace: Workspace,
    agentAccess: AgentAccessContext | undefined,
    origin: 'knowledge_query' | 'iself_knowledge_query',
  ) {
    const robot =
      origin === 'iself_knowledge_query' ||
      dto.type === KnowledgeQueryType.ROBOT;
    const personalKey = getApiKeyAccess(user);
    if (robot && !agentAccess && personalKey?.keyType !== ApiKeyType.PERSONAL) {
      throw new UnauthorizedException(
        'Robot queries require a personal API key or a user credential with an Agent API key',
      );
    }
    if (!robot && agentAccess) {
      throw new BadRequestException(
        'Agent API keys are only valid for robot queries',
      );
    }

    if (!this.chatService.isEnabledForWorkspace(workspace)) {
      throw new ForbiddenException(
        errorBody(
          ErrorCode.AI_KNOWLEDGE_DISABLED,
          'AI knowledge chat is disabled',
        ),
      );
    }

    const boundSpaceIds = agentAccess
      ? await this.agentAccessService.getBoundSpaceIds(agentAccess)
      : undefined;

    const result = await this.chatService.chat({
      workspaceId: workspace.id,
      userId: user.id,
      supplementalSpaceIds: boundSpaceIds,
      query: dto.query,
      spaceIds: dto.spaceIds,
      ...(dto.labels?.length ? { labelNames: dto.labels } : {}),
      chatContext: dto.chatContext,
      workspace,
      ...(robot
        ? { generalKnowledgeEnabled: dto.generalKnowledgeEnabled === true }
        : isGeneralKnowledgeEnabledForUser(user)
          ? {}
          : { generalKnowledgeEnabled: false }),
      collectTimings: true,
      ...(dto.scoreThreshold !== undefined
        ? { scoreThreshold: dto.scoreThreshold }
        : {}),
      ...(dto.rawResultsOnly === true ? { rawResultsOnly: true } : {}),
      ...(dto.queryRewriteEnabled !== undefined
        ? { queryRewriteEnabled: dto.queryRewriteEnabled }
        : {}),
    });
    const queryHash = hashQuery(dto.query);
    const {
      retrievalDiagnostics,
      retrievalScope,
      attachmentHitContext,
      timings,
      queryObservation,
      retrieval,
      context,
      ...response
    } = result;
    const requestedSpaceIds = retrievalScope?.requestedSpaceIds ?? dto.spaceIds;
    const effectiveSpaceIds =
      retrievalScope?.effectiveSpaceIds ?? requestedSpaceIds;
    const scopeMetadata = {
      ...(robot ? { type: KnowledgeQueryType.ROBOT } : {}),
      spaceIds: dto.spaceIds,
      ...(dto.labels?.length ? { labelCount: dto.labels.length } : {}),
      requestedSpaceIds,
      effectiveSpaceIds,
      publicScopeValidated: Boolean(agentAccess),
      ...(agentAccess ? { publicApiKeyId: agentAccess.apiKeyId } : {}),
      ...(personalKey ? { personalApiKeyId: personalKey.apiKeyId } : {}),
    };

    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_QUERY,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: workspace.id,
      metadata: {
        origin,
        queryHash,
        ...scopeMetadata,
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
        origin,
        answerMode: response.answerMode,
        ...scopeMetadata,
        ...(timings ? { timings } : {}),
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
    const attachments =
      robot && dto.attachments === true
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
