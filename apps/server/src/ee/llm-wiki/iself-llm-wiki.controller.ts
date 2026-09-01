import {
  ForbiddenException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
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
  AiKnowledgeRetrievalResult,
} from './services/ai-knowledge-chat.service';
import { IsElfAgentAuthGuard } from './guards/iself-agent-auth.guard';

/** HTTP boundary for external agents that judge retrieved evidence themselves. */
@UseGuards(IsElfAgentAuthGuard)
@Controller('iself/llm-wiki')
export class IsElfLlmWikiController {
  constructor(
    private readonly chatService: AiKnowledgeChatService,
    private readonly queryAuditRepo: KnowledgeQueryAuditRepo,
    private readonly apiKeyService: ApiKeyService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    @Optional() private readonly environmentService?: EnvironmentService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('query')
  async queryKnowledge(
    @Body() dto: QueryKnowledgeDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Headers('x-akasha-public-key') publicApiKey?: string,
  ): Promise<AiKnowledgeRetrievalResult> {
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
    if (dto.spaceIds.some((spaceId) => !allowedSpaceIds.has(spaceId))) {
      throw new ForbiddenException(
        'Requested Spaces are outside the Public API key scope',
      );
    }

    const result = await this.chatService.retrieveOnly({
      workspaceId: workspace.id,
      userId: user.id,
      query: dto.query,
      spaceIds: dto.spaceIds,
      workspace,
    });
    const queryHash = hashQuery(dto.query);
    const requestedSpaceIds = result.retrievalScope.requestedSpaceIds;
    const effectiveSpaceIds = result.retrievalScope.effectiveSpaceIds;
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
        citationCount: result.citations.length,
      },
    });

    await this.queryAuditRepo.recordQuery({
      workspaceId: workspace.id,
      userId: user.id,
      queryHash,
      retrievalMode: result.retrievalDiagnostics.mode,
      authorizedCapsuleCount: result.retrievalDiagnostics.authorizedChunkCount,
      metadata: {
        origin: 'iself_knowledge_query',
        spaceIds: dto.spaceIds,
        requestedSpaceIds,
        effectiveSpaceIds,
        publicScopeValidated,
        publicApiKeyId: publicAccess.apiKeyId,
        queryEmbeddingAvailable:
          result.retrievalDiagnostics.queryEmbeddingAvailable,
        candidateSourceCount: result.retrievalDiagnostics.candidateSourceCount,
        policyCandidateSourceCount:
          result.retrievalDiagnostics.policyCandidateSourceCount,
        fallbackCandidateSourceCount:
          result.retrievalDiagnostics.fallbackCandidateSourceCount,
        finalAuthorizedSourceCount:
          result.retrievalDiagnostics.finalAuthorizedSourceCount,
        accessPolicyFallbackUsed:
          result.retrievalDiagnostics.accessPolicyFallbackUsed,
        candidateChunkCount: result.retrievalDiagnostics.candidateChunkCount,
        rankedCandidateCount: result.retrievalDiagnostics.rankedCandidateCount,
        authorizedChunkCount: result.retrievalDiagnostics.authorizedChunkCount,
        filteredChunkCount: result.retrievalDiagnostics.filteredChunkCount,
      },
    });

    const appUrl = this.environmentService?.getAppUrl();
    return {
      ...result,
      citations: mapCitationUrls(result.citations, appUrl),
      citationEvidence: result.citationEvidence.map((evidence) => ({
        ...evidence,
        url: toAppCitationUrl(evidence.url, appUrl),
        excerpts: evidence.excerpts,
      })),
      retrievedSources: mapCitationUrls(result.retrievedSources, appUrl),
      snippets: result.snippets.map((snippet) => ({
        ...snippet,
        sourceWindows: mapCitationUrls(snippet.sourceWindows, appUrl),
      })),
    };
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
