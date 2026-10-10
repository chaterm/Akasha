import {
  Body,
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UnauthorizedException,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectQueue } from '@nestjs/bullmq';
import { createHash } from 'crypto';
import { Queue } from 'bullmq';
import { User, Workspace } from '@akasha/db/types/entity.types';
import { KnowledgeQueryAuditRepo } from '@akasha/db/repos/llm-wiki/knowledge-query-audit.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UserRole } from '../../common/helpers/types/permission';
import { SpaceAuthorizationService } from '../../core/space/services/space-authorization.service';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { AdminKnowledgeSpaceActionDto } from './dto/admin-space-action.dto';
import { CompileSpacesDto } from './dto/compile-spaces.dto';
import { CancelKnowledgeRunDto } from './dto/cancel-knowledge-run.dto';
import {
  AdminKnowledgeDelayedPageListDto,
  AdminKnowledgeImmediateCompileDelayedPageDto,
  AdminKnowledgeRemoveDelayedPageDto,
  AdminKnowledgePageLogDto,
  AdminKnowledgeQuarantineListDto,
  AdminKnowledgeRunListDto,
  AdminKnowledgeRunPagesQueryDto,
  AdminKnowledgeRunSummaryDto,
} from './dto/admin-diagnostics.dto';
import { AdminKnowledgeRetryPagesDto } from './dto/admin-retry-pages.dto';
import { KnowledgeGraphDto } from './dto/knowledge-graph.dto';
import { KnowledgeSpaceOperationDto } from './dto/knowledge-space-operation.dto';
import { QueryKnowledgeDto } from './dto/query-knowledge.dto';
import { KnowledgeQueryType } from './dto/query-knowledge.dto';
import { CitationPageDto } from './dto/citation-page.dto';
import {
  AiKnowledgeChatService,
  AiKnowledgeChatResult,
  isGeneralKnowledgeEnabledForUser,
} from './services/ai-knowledge-chat.service';
import { KnowledgeCitationImageResolverService } from './services/knowledge-citation-image-resolver.service';
import { KnowledgeQueryCitation } from './services/knowledge-context-pack.service';
import { KnowledgeDiagnosticsService } from './services/knowledge-diagnostics.service';
import { KnowledgeGraphService } from './services/knowledge-graph.service';
import { KnowledgeSourceExporterService } from './services/knowledge-source-exporter.service';
import { KnowledgeSpaceCompilationService } from './services/knowledge-space-compilation.service';
import { KnowledgeSpaceResetService } from './services/knowledge-space-reset.service';
import { AiModelConfigService } from './services/ai-model-config.service';
import { AiModelConfigTestService } from './services/ai-model-config-test.service';
import { AiModelConfigFeature } from '../../database/repos/llm-wiki/ai-model-config.repo';
import { buildKnowledgeQueryAuditMetadata } from './services/knowledge-query-audit-metadata';
import {
  TestAiModelConfigDto,
  UpdateAiModelConfigDto,
} from './dto/ai-model-config.dto';
import {
  buildKnowledgeAdminActionJobId,
  uniqueValues,
} from './services/knowledge-queue.utils';
import { KnowledgeAdminSpaceAction } from './types/knowledge-queue.types';
import { getPageTitle } from '../../common/helpers';
import { jsonToMarkdown } from '../../collaboration/collaboration.util';
import { ApiKeyService } from '../api-key/api-key.service';
import { getApiKeyAccess } from '../../common/auth/api-key-access';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { AgentCallable } from '../../common/decorators/agent-callable.decorator';
import { AgentCapability } from '../../common/auth/agent-capability';
import { AgentAccess } from '../../common/decorators/agent-access.decorator';
import type { AgentAccessContext } from '../../common/auth/agent-access-context';
import { AgentAccessService } from '../../core/page/page-access/agent-access.service';

@UseGuards(JwtAuthGuard)
@Controller('llm-wiki')
export class LlmWikiController {
  private readonly logger = new Logger(LlmWikiController.name);
  private static readonly PUBLISH_COOLDOWN_MS = [
    10 * 60_000,
    30 * 60_000,
    2 * 60 * 60_000,
  ];
  private static readonly PUBLISH_COOLDOWN_TTL = 24 * 60 * 60_000;

  constructor(
    private readonly chatService: AiKnowledgeChatService,
    private readonly citationImageResolver: KnowledgeCitationImageResolverService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    private readonly diagnosticsService: KnowledgeDiagnosticsService,
    private readonly graphService: KnowledgeGraphService,
    private readonly queryAuditRepo: KnowledgeQueryAuditRepo,
    @InjectQueue(QueueName.KNOWLEDGE_TEXT_QUEUE)
    private readonly knowledgeQueue: Queue,
    private readonly pageRepo: PageRepo,
    private readonly sourceExporter: KnowledgeSourceExporterService,
    private readonly spaceCompilation: KnowledgeSpaceCompilationService,
    private readonly spaceReset: KnowledgeSpaceResetService,
    private readonly spaceAuthorization: SpaceAuthorizationService,
    private readonly pageAccessService: PageAccessService,
    private readonly aiModelConfigService: AiModelConfigService,
    private readonly aiModelConfigTestService: AiModelConfigTestService,
    private readonly apiKeyService: ApiKeyService,
    @Optional() private readonly environmentService?: EnvironmentService,
    @Optional() private readonly agentAccessService?: AgentAccessService,
    @Inject(CACHE_MANAGER) private readonly cacheManager?: Cache,
  ) {}

  private publishCooldownKey(pageId: string) {
    return `llm-wiki:page-publish-cooldown:${pageId}`;
  }

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

    const queryType = dto.type ?? KnowledgeQueryType.USER;
    let publicApiKeyId: string | undefined;
    if (queryType === KnowledgeQueryType.ROBOT) {
      const personalApiKeyAccess = getApiKeyAccess(user);
      if (!personalApiKeyAccess) {
        throw new UnauthorizedException(
          'Robot queries require a personal API key',
        );
      }
      // Robot queries can authenticate with a single personal API key. A
      // Public API key remains supported when supplied, in which case its
      // Space scope is enforced as an additional restriction.
      if (publicApiKey) {
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
        publicApiKeyId = publicAccess.apiKeyId;
      }
    } else if (publicApiKey !== undefined) {
      throw new BadRequestException(
        'Public API keys are only valid for robot queries',
      );
    }

    const personalApiKeyId = getApiKeyAccess(user)?.apiKeyId;
    const result = await this.chatService.chat({
      workspaceId: workspace.id,
      userId: user.id,
      query: dto.query,
      spaceIds: dto.spaceIds,
      ...(dto.labels?.length ? { labelNames: dto.labels } : {}),
      chatContext: dto.chatContext,
      workspace,
      ...(isGeneralKnowledgeEnabledForUser(user)
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
    // attachmentHitContext is an internal retrieval detail (§7.1): the regular
    // query API never resolves top-level attachments, so strip it here too so it
    // can never leak through `...response` as a public field. `timings`,
    // `queryObservation`, `retrieval`, and `context` are likewise internal:
    // they go to the query audit, not to the API response.
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
    void attachmentHitContext;
    // The knowledge path always returns a scope. Keep audit recording
    // defensive for the legacy pure-general path and older service mocks.
    const requestedSpaceIds = retrievalScope?.requestedSpaceIds ?? dto.spaceIds;
    const effectiveSpaceIds =
      retrievalScope?.effectiveSpaceIds ?? requestedSpaceIds;
    const publicScopeValidated = Boolean(publicApiKeyId);

    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_QUERY,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: workspace.id,
      metadata: {
        queryHash,
        ...(queryType === KnowledgeQueryType.ROBOT ? { type: queryType } : {}),
        spaceIds: dto.spaceIds,
        ...(dto.labels?.length ? { labelCount: dto.labels.length } : {}),
        requestedSpaceIds,
        effectiveSpaceIds,
        publicScopeValidated,
        ...(personalApiKeyId ? { personalApiKeyId } : {}),
        ...(publicApiKeyId ? { publicApiKeyId } : {}),
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
        origin: 'knowledge_query',
        ...(queryType === KnowledgeQueryType.ROBOT ? { type: queryType } : {}),
        answerMode: response.answerMode,
        spaceIds: dto.spaceIds,
        ...(dto.labels?.length ? { labelCount: dto.labels.length } : {}),
        requestedSpaceIds,
        effectiveSpaceIds,
        publicScopeValidated,
        ...(personalApiKeyId ? { personalApiKeyId } : {}),
        ...(publicApiKeyId ? { publicApiKeyId } : {}),
        ...buildKnowledgeQueryAuditMetadata({
          answerMode: response.answerMode,
          queryObservation,
          retrievalDiagnostics,
          retrieval,
          context,
        }),
        ...(timings ? { timings } : {}),
      },
    });

    // Image enrichment is a non-critical add-on: it must never change the
    // availability of the answer text or the base citations. On any resolver
    // failure we degrade every citation to `images: []` and still return the
    // original response (§4.3 整体 fail-open 边界).
    const citationsWithImages = await this.resolveCitationImages({
      workspaceId: workspace.id,
      answer: response.answer,
      citations: response.citations,
      citationEvidence: response.citationEvidence,
    });
    const appUrl = this.environmentService?.getAppUrl();

    return {
      ...response,
      citations: mapCitationUrls(citationsWithImages, appUrl),
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
  }): Promise<KnowledgeQueryCitation[]> {
    const emptyImages = (): KnowledgeQueryCitation[] =>
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

  @HttpCode(HttpStatus.OK)
  @Post('citation-page')
  @AgentCallable(AgentCapability.PAGE_READ)
  async getCitationPage(
    @Body() dto: CitationPageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @AgentAccess() agentAccess?: AgentAccessContext,
  ) {
    const match = /^\/p\/([A-Za-z0-9_-]+)$/.exec(dto.pageUrl);
    if (!match) {
      throw new BadRequestException('Invalid Akasha shared Page URL');
    }

    const slugId = match[1];
    const page = await this.pageRepo.findById(slugId, {
      includeContent: true,
    });
    if (!page || page.workspaceId !== workspace.id || page.deletedAt !== null) {
      throw new NotFoundException('Shared Page not found');
    }

    if (agentAccess) {
      if (!this.agentAccessService) {
        throw new ForbiddenException('Agent page authorization unavailable');
      }
      await this.agentAccessService.assertPageReadable(agentAccess, page);
    } else {
      await this.pageAccessService.validateCanReadCitationSourceWithPermissions(
        page,
        user,
      );
    }

    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_CITATION_PAGE_READ,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      metadata: {
        origin: 'citation_page_url',
        pageUrl: dto.pageUrl,
      },
    });

    return {
      pageId: page.id,
      spaceId: page.spaceId,
      title: getPageTitle(page.title),
      url: toAppCitationUrl(
        `/p/${page.slugId}`,
        this.environmentService?.getAppUrl(),
      ),
      content: page.content ? jsonToMarkdown(page.content) : '',
      updatedAt: page.updatedAt,
    };
  }

  @Get('graph')
  async getGraph(
    @Query() dto: KnowledgeGraphDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (!this.chatService.isEnabledForWorkspace(workspace)) {
      throw new ForbiddenException('AI knowledge chat is disabled');
    }

    return this.graphService.getSpaceGraph({
      workspaceId: workspace.id,
      userId: user.id,
      spaceId: dto.spaceId,
      limit: dto.limit,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Get('pages/:pageId/publish-cooldown')
  async getPagePublishCooldown(@Param('pageId', ParseUUIDPipe) pageId: string) {
    const state = await this.cacheManager?.get<{
      step: number;
      expiresAt: number;
    }>(this.publishCooldownKey(pageId));
    const now = Date.now();
    if (!state || state.expiresAt <= now) {
      if (
        state?.expiresAt &&
        state.expiresAt <= now &&
        state.step >= LlmWikiController.PUBLISH_COOLDOWN_MS.length
      ) {
        await this.cacheManager?.del(this.publishCooldownKey(pageId));
      }
      return { expiresAt: null, step: 0 };
    }
    return state;
  }

  @HttpCode(HttpStatus.OK)
  @Get('pages/:pageId/compile-status')
  async getPageCompileStatus(
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pageRepo.findById(pageId);
    if (!page || page.workspaceId !== workspace.id || page.deletedAt !== null) {
      throw new NotFoundException('Page not found');
    }
    return this.spaceCompilation.getPageCompileStatus({
      workspaceId: workspace.id,
      spaceId: page.spaceId,
      sourcePageId: page.id,
      currentSourceVersion: page.updatedAt?.toISOString(),
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('pages/:pageId/publish')
  async publishPageKnowledge(
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (!this.chatService.isEnabledForWorkspace(workspace)) {
      throw new ForbiddenException('AI knowledge chat is disabled');
    }

    const page = await this.pageRepo.findById(pageId);
    if (!page || page.workspaceId !== workspace.id || page.deletedAt !== null) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanEdit(page, user);

    const cooldownKey = this.publishCooldownKey(page.id);
    const cooldown = await this.cacheManager?.get<{
      step: number;
      expiresAt: number;
    }>(cooldownKey);
    if (cooldown && cooldown.expiresAt > Date.now()) {
      throw new HttpException(
        {
          message: 'Page publish is cooling down',
          expiresAt: cooldown.expiresAt,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const request = await this.spaceCompilation.requestImmediatePagePublish({
      workspaceId: workspace.id,
      spaceId: page.spaceId,
      sourcePageId: page.id,
    });
    const run = request.run!;
    const step = Math.min(
      (cooldown?.step ?? 0) + 1,
      LlmWikiController.PUBLISH_COOLDOWN_MS.length,
    );
    const expiresAt =
      Date.now() + LlmWikiController.PUBLISH_COOLDOWN_MS[step - 1];
    await this.cacheManager?.set(
      cooldownKey,
      { step, expiresAt },
      LlmWikiController.PUBLISH_COOLDOWN_TTL,
    );
    const result = {
      pageId: page.id,
      spaceId: page.spaceId,
      runId: run.id,
      disposition: request.disposition,
      mode: 'incremental' as const,
      knowledgeGeneration: run.knowledgeGeneration,
    };

    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_COMPILE_QUEUED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      metadata: {
        origin: 'manual_page_publish',
        runId: run.id,
        disposition: request.disposition,
        priority: 0,
      },
    });

    return result;
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/spaces/:spaceId/update-knowledge')
  async updateSpaceKnowledge(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: KnowledgeSpaceOperationDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertKnowledgeOperationAllowed(user, workspace);
    const [request] = await this.spaceCompilation.requestRuns([
      {
        workspaceId: workspace.id,
        spaceId,
        trigger: 'manual_compile',
        confirmationSpaceName: dto.confirmationSpaceName,
        scanRemovedSources: true,
      },
    ]);
    const run = request.run!;
    const result = {
      runId: run.id,
      mode: 'incremental' as const,
      knowledgeGeneration: run.knowledgeGeneration,
    };
    this.auditKnowledgeOperation(spaceId, result);
    return result;
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/spaces/:spaceId/force-rebuild-knowledge')
  async forceRebuildSpaceKnowledge(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: KnowledgeSpaceOperationDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertKnowledgeOperationAllowed(user, workspace);
    const reset = await this.spaceReset.forceRebuild({
      workspaceId: workspace.id,
      spaceId,
      confirmationSpaceName: dto.confirmationSpaceName,
    });
    const result = {
      runId: reset.run.id,
      mode: 'force_rebuild' as const,
      knowledgeGeneration: reset.generation,
    };
    this.auditKnowledgeOperation(spaceId, result);
    return result;
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/compile-spaces')
  async compileSpaces(
    @Body() dto: CompileSpacesDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (!this.chatService.isEnabledForWorkspace(workspace)) {
      throw new ForbiddenException('AI knowledge chat is disabled');
    }

    this.assertAdmin(user, 'AI knowledge compile is restricted to admins');

    const spaceIds = uniqueValues(dto.spaceIds);
    const requests = await this.spaceCompilation.requestRuns(
      spaceIds.map((spaceId) => ({
        workspaceId: workspace.id,
        spaceId,
        trigger: 'manual_compile',
        scanRemovedSources: true,
      })),
    );
    const runs = requests.map((request, index) => ({
      spaceId: request.run!.spaceId ?? spaceIds[index],
      runId: request.run!.id,
      disposition: request.disposition as
        | 'created'
        | 'coalesced'
        | 'rerun_requested',
    }));
    const result = {
      requestedSpaceCount: spaceIds.length,
      acceptedRunCount: runs.length,
      coalescedRunCount: runs.filter((run) => run.disposition === 'coalesced')
        .length,
      rerunRequestedCount: runs.filter(
        (run) => run.disposition === 'rerun_requested',
      ).length,
      runs,
    };

    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_COMPILE_QUEUED,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: workspace.id,
      metadata: {
        spaceIds,
        acceptedRunCount: result.acceptedRunCount,
        coalescedRunCount: result.coalescedRunCount,
        rerunRequestedCount: result.rerunRequestedCount,
      },
    });

    return result;
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/space-action')
  async runAdminSpaceAction(
    @Body() dto: AdminKnowledgeSpaceActionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (!this.chatService.isEnabledForWorkspace(workspace)) {
      throw new ForbiddenException('AI knowledge chat is disabled');
    }

    this.assertAdmin(user, 'AI knowledge actions are restricted to admins');

    const result = await this.enqueueAdminSpaceAction({
      workspaceId: workspace.id,
      spaceIds: dto.spaceIds,
      action: dto.action,
    });

    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_COMPILE_QUEUED,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: workspace.id,
      metadata: {
        action: dto.action,
        spaceIds: uniqueValues(dto.spaceIds),
        queuedSpaceCount: result.queuedSpaceCount,
      },
    });

    return result;
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/diagnostics/summary')
  async getRunDiagnosticsSummary(
    @Body() dto: AdminKnowledgeRunSummaryDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertDiagnosticsEnabled(workspace);
    const spaceIds = await this.findAuthorizedDiagnosticSpaceIds(
      dto.spaceIds,
      user,
      workspace,
    );
    return this.diagnosticsService.getRunDiagnosticsSummary({
      workspaceId: workspace.id,
      spaceIds,
      enforceSpaceScope: true,
      canViewGlobalQueues: user.role === UserRole.OWNER,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/diagnostics/runs')
  async getRunDiagnostics(
    @Body() dto: AdminKnowledgeRunListDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertDiagnosticsEnabled(workspace);
    const spaceIds = await this.findAuthorizedDiagnosticSpaceIds(
      dto.spaceIds,
      user,
      workspace,
    );
    return this.diagnosticsService.listRunDiagnostics({
      workspaceId: workspace.id,
      spaceIds,
      enforceSpaceScope: true,
      statuses: dto.statuses,
      phases: dto.phases,
      search: dto.search,
      page: dto.page,
      limit: dto.limit,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/diagnostics/delayed-pages')
  async getDelayedPageDiagnostics(
    @Body() dto: AdminKnowledgeDelayedPageListDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertDiagnosticsEnabled(workspace);
    const spaceIds = await this.findAuthorizedDiagnosticSpaceIds(
      dto.spaceIds,
      user,
      workspace,
    );
    return this.diagnosticsService.listDelayedPageDiagnostics({
      workspaceId: workspace.id,
      spaceIds,
      enforceSpaceScope: true,
      statuses: dto.statuses,
      search: dto.search,
      page: dto.page,
      limit: dto.limit,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/diagnostics/delayed-pages/:scheduleId/immediate-compile')
  async immediatelyCompileDelayedPage(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Body() dto: AdminKnowledgeImmediateCompileDelayedPageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertKnowledgeOperationAllowed(user, workspace);
    const result =
      await this.spaceCompilation.requestImmediateDelayedPageCompilation({
        workspaceId: workspace.id,
        scheduleId,
        confirmationPageName: dto.confirmationPageName,
      });
    if (!result) {
      throw new BadRequestException(
        'Delayed page is unavailable or page name confirmation does not match',
      );
    }

    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_COMPILE_QUEUED,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: result.sourcePageId,
      spaceId: result.spaceId,
      metadata: {
        action: 'immediate_compile_delayed_page',
        scheduleId: result.scheduleId,
        sourcePageId: result.sourcePageId,
        pageName: result.pageName,
      },
    });
    return {
      accepted: true,
      scheduleId: result.scheduleId,
      sourcePageId: result.sourcePageId,
      spaceId: result.spaceId,
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/diagnostics/delayed-pages/:scheduleId/remove')
  async removeDelayedPageFromQueue(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Body() dto: AdminKnowledgeRemoveDelayedPageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertKnowledgeOperationAllowed(user, workspace);
    const result = await this.spaceCompilation.removeDelayedPageCompilation({
      workspaceId: workspace.id,
      scheduleId,
      confirmationPageName: dto.confirmationPageName,
    });
    if (!result) {
      throw new BadRequestException(
        'Delayed page is unavailable or page name confirmation does not match',
      );
    }

    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_DELAYED_PAGE_REMOVED,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: result.sourcePageId,
      spaceId: result.spaceId,
      metadata: {
        action: 'remove_delayed_page_from_queue',
        scheduleId: result.scheduleId,
        sourcePageId: result.sourcePageId,
        pageName: result.pageName,
      },
    });
    return {
      removed: true,
      scheduleId: result.scheduleId,
      sourcePageId: result.sourcePageId,
      spaceId: result.spaceId,
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/diagnostics/page-log')
  async getPageCompilationLog(
    @Body() dto: AdminKnowledgePageLogDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertDiagnosticsEnabled(workspace);
    const spaceIds = await this.findAuthorizedDiagnosticSpaceIds(
      dto.spaceIds,
      user,
      workspace,
    );
    return this.diagnosticsService.listPageCompilationLog({
      workspaceId: workspace.id,
      spaceIds,
      enforceSpaceScope: true,
      statuses: dto.statuses,
      mergeStatuses: dto.mergeStatuses,
      search: dto.search,
      from: dto.from,
      to: dto.to,
      page: dto.page,
      limit: dto.limit,
      includeSensitiveErrors:
        user.role === UserRole.OWNER || user.role === UserRole.ADMIN,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/diagnostics/quality')
  async getQualityDiagnostics(
    @Body() dto: AdminKnowledgeRunSummaryDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertDiagnosticsEnabled(workspace);
    const spaceIds = await this.findAuthorizedDiagnosticSpaceIds(
      dto.spaceIds,
      user,
      workspace,
    );
    return this.diagnosticsService.getQualityDiagnostics({
      workspaceId: workspace.id,
      spaceIds,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/diagnostics/quarantine')
  async getQuarantineDiagnostics(
    @Body() dto: AdminKnowledgeQuarantineListDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertDiagnosticsEnabled(workspace);
    if (user.role !== UserRole.OWNER) {
      throw new ForbiddenException(
        'Knowledge quarantine diagnostics are restricted to workspace owners',
      );
    }
    const spaceIds = await this.findAuthorizedDiagnosticSpaceIds(
      dto.spaceIds,
      user,
      workspace,
    );
    return this.diagnosticsService.listQuarantineDiagnostics({
      workspaceId: workspace.id,
      spaceIds,
      page: dto.page,
      limit: dto.limit,
    });
  }

  @Get('admin/diagnostics/retrieval')
  async getRetrievalDiagnostics(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertDiagnosticsEnabled(workspace);
    if (user.role !== UserRole.OWNER) {
      throw new ForbiddenException(
        'Knowledge retrieval diagnostics are restricted to workspace owners',
      );
    }
    return this.diagnosticsService.getRetrievalDiagnostics({
      workspaceId: workspace.id,
    });
  }

  @Get('admin/diagnostics/runs/:runId/pages')
  async getRunPageDiagnostics(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Query() dto: AdminKnowledgeRunPagesQueryDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertDiagnosticsEnabled(workspace);
    const spaceId = await this.diagnosticsService.findRunDiagnosticSpaceId({
      workspaceId: workspace.id,
      runId,
    });
    if (!spaceId) throw new NotFoundException('Knowledge Run not found');
    const allowedSpaceIds =
      await this.spaceAuthorization.filterReadableSpaceIds({
        user: {
          id: user.id,
          role: user.role ?? UserRole.MEMBER,
          workspaceId: workspace.id,
        },
        spaceIds: [spaceId],
      });
    const result = await this.diagnosticsService.listRunPageDiagnostics({
      workspaceId: workspace.id,
      runId,
      allowedSpaceIds,
      page: dto.page,
      limit: dto.limit,
      includeSensitiveErrors:
        user.role === UserRole.OWNER || user.role === UserRole.ADMIN,
    });
    if (!result) throw new NotFoundException('Knowledge Run not found');
    return result;
  }

  @Get('admin/diagnostics/workers')
  async getKnowledgeWorkerDiagnostics(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertDiagnosticsEnabled(workspace);
    if (user.role !== UserRole.OWNER) {
      throw new ForbiddenException(
        'Knowledge worker diagnostics are restricted to workspace owners',
      );
    }
    return this.diagnosticsService.getWorkerDiagnostics();
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/compilation-runs/:runId/cancel')
  async cancelKnowledgeCompilationRun(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() dto: CancelKnowledgeRunDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertKnowledgeOperationAllowed(user, workspace);
    const reason =
      dto.reason
        ?.replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, 400) || undefined;
    const result = await this.spaceCompilation.cancelRun({
      workspaceId: workspace.id,
      runId,
      reason,
    });
    if (result.disposition === 'cancelled') {
      this.auditService.log({
        event: AuditEvent.KNOWLEDGE_COMPILE_CANCELLED,
        resourceType: AuditResource.KNOWLEDGE,
        resourceId: runId,
        spaceId: result.spaceId,
        metadata: {
          runId,
          previousStatus: result.previousStatus,
          previousPhase: result.previousPhase,
          reason,
          removedJobCount: result.removedJobCount,
          fencedActiveJobCount: result.fencedActiveJobCount,
          cleanupErrorCount: result.cleanupErrorCount,
        },
      });
    }
    return result;
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/retry-pages')
  async retryPages(
    @Body() dto: AdminKnowledgeRetryPagesDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<{ queuedPageCount: number; jobIds: string[] }> {
    if (!this.chatService.isEnabledForWorkspace(workspace)) {
      throw new ForbiddenException('AI knowledge chat is disabled');
    }
    this.assertAdmin(user, 'AI knowledge retry is restricted to admins');

    const pageIds = uniqueValues(dto.pageIds);
    const pageRefs = await this.pageRepo.findExistingPageRefs({
      workspaceId: workspace.id,
      pageIds,
    });
    const pageById = new Map(
      pageRefs
        .filter((page) => !page.deletedAt)
        .map((page) => [page.id, page] as const),
    );
    if (pageIds.some((pageId) => !pageById.has(pageId))) {
      throw new BadRequestException(
        'One or more source pages are unavailable for retry',
      );
    }

    const pagesBySpace = new Map<string, (typeof pageRefs)[number][]>();
    for (const pageId of pageIds) {
      const page = pageById.get(pageId) as (typeof pageRefs)[number];
      const pages = pagesBySpace.get(page.spaceId) ?? [];
      pages.push(page);
      pagesBySpace.set(page.spaceId, pages);
    }
    const compiledPageIds = new Set(
      await this.diagnosticsService.findCompiledPageIds({
        workspaceId: workspace.id,
        sourcePageIds: pageIds,
      }),
    );
    if (pageIds.some((pageId) => !compiledPageIds.has(pageId))) {
      throw new BadRequestException(
        'Only pages that have already been compiled can be retried',
      );
    }

    // Refuse to retry while any involved Space still has a Run in flight. A
    // retry mid-Run would coalesce into (or re-request) the live Run, and the
    // cache reset below would null the still-published Run's extraction links.
    // Ask the admin to wait for the current compilation to finish, then retry.
    const spacesWithActiveRun =
      await this.spaceCompilation.findSpaceIdsWithActiveRun({
        workspaceId: workspace.id,
        spaceIds: [...pagesBySpace.keys()],
      });
    if (spacesWithActiveRun.length > 0) {
      throw new ConflictException(
        'A compilation run is still in progress for the selected pages. Wait for it to finish, then retry.',
      );
    }

    // Drop the durable image-understanding cache for these pages too. Without
    // this, a retried Run would claim the prior `ready` extractions and skip
    // the VLM, so images that failed or need refreshing are never recompiled.
    await this.spaceCompilation.clearImageExtractionCache({
      workspaceId: workspace.id,
      sourcePageIds: pageIds,
    });
    const requests = await this.spaceCompilation.requestRuns(
      [...pagesBySpace.entries()].map(([spaceId, spacePages]) => ({
        workspaceId: workspace.id,
        spaceId,
        trigger: 'page_retry',
        // Compile only the selected failed pages, not the whole Space.
        targetSourcePageIds: spacePages.map((page) => page.id),
      })),
    );
    const jobIds = requests.map((request) => request.run!.id);

    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_COMPILE_QUEUED,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: workspace.id,
      metadata: {
        action: 'retry_pages',
        pageIds,
        queuedPageCount: jobIds.length,
      },
    });
    return { queuedPageCount: jobIds.length, jobIds };
  }

  @HttpCode(HttpStatus.OK)
  @Get('admin/model-configs')
  async listModelConfigs(@AuthUser() user: User) {
    this.assertAdmin(user, 'AI model configuration is restricted to admins');
    return { configs: await this.aiModelConfigService.listConfigViews() };
  }

  @HttpCode(HttpStatus.OK)
  @Put('admin/model-configs/:feature')
  async updateModelConfig(
    @Param('feature') feature: string,
    @Body() dto: UpdateAiModelConfigDto,
    @AuthUser() user: User,
  ) {
    this.assertAdmin(user, 'AI model configuration is restricted to admins');
    if (!isModelConfigFeature(feature)) {
      throw new BadRequestException('Unknown AI model configuration feature.');
    }
    return this.aiModelConfigService.updateConfig(feature, {
      provider: dto.provider,
      model: dto.model,
      baseUrl: dto.baseUrl ?? null,
      apiKey: dto.apiKey,
      parameters: dto.parameters as unknown as
        | Record<string, unknown>
        | null
        | undefined,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/model-configs/:feature/test')
  async testModelConfig(
    @Param('feature') feature: string,
    @Body() dto: TestAiModelConfigDto,
    @AuthUser() user: User,
  ) {
    this.assertAdmin(user, 'AI model configuration is restricted to admins');
    if (!isModelConfigFeature(feature)) {
      throw new BadRequestException('Unknown AI model configuration feature.');
    }
    return this.aiModelConfigTestService.testConfig(feature, {
      provider: dto.provider,
      model: dto.model,
      baseUrl: dto.baseUrl ?? null,
      apiKey: dto.apiKey,
      parameters: dto.parameters
        ? (dto.parameters as unknown as Record<string, unknown>)
        : null,
    });
  }

  private assertAdmin(user: User, message: string): void {
    if (user.role !== UserRole.OWNER && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException(message);
    }
  }

  private assertDiagnosticsEnabled(workspace: Workspace): void {
    if (!this.chatService.isEnabledForWorkspace(workspace)) {
      throw new ForbiddenException('AI knowledge chat is disabled');
    }
  }

  private async findAuthorizedDiagnosticSpaceIds(
    requestedSpaceIds: string[] | undefined,
    user: User,
    workspace: Workspace,
  ): Promise<string[]> {
    const candidateSpaceIds =
      await this.diagnosticsService.findWorkspaceSpaceIds({
        workspaceId: workspace.id,
        requestedSpaceIds,
      });
    return this.spaceAuthorization.filterReadableSpaceIds({
      user: {
        id: user.id,
        role: user.role ?? UserRole.MEMBER,
        workspaceId: workspace.id,
      },
      spaceIds: candidateSpaceIds,
    });
  }

  private assertKnowledgeOperationAllowed(
    user: User,
    workspace: Workspace,
  ): void {
    if (!this.chatService.isEnabledForWorkspace(workspace)) {
      throw new ForbiddenException('AI knowledge chat is disabled');
    }
    this.assertAdmin(user, 'AI knowledge compile is restricted to admins');
  }

  private auditKnowledgeOperation(
    spaceId: string,
    result: {
      runId: string;
      mode: 'incremental' | 'force_rebuild';
      knowledgeGeneration: number;
    },
  ): void {
    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_COMPILE_QUEUED,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: spaceId,
      metadata: result,
    });
  }

  private async enqueueAdminSpaceAction(input: {
    workspaceId: string;
    spaceIds: string[];
    action: KnowledgeAdminSpaceAction;
  }): Promise<{
    action: KnowledgeAdminSpaceAction;
    queuedSpaceCount: number;
    jobIds: string[];
  }> {
    if (input.action === 'retry_compile') {
      throw new BadRequestException(
        'Retry compile requires explicitly selected failed page IDs',
      );
    }

    if (input.action === 'rebuild_embeddings') {
      const spaceIds = uniqueValues(input.spaceIds);
      const jobIds: string[] = [];
      for (const spaceId of spaceIds) {
        const jobId = buildKnowledgeAdminActionJobId({
          action: input.action,
          workspaceId: input.workspaceId,
          spaceId,
        });
        await this.knowledgeQueue.add(
          QueueJob.KNOWLEDGE_REBUILD_EMBEDDINGS,
          { workspaceId: input.workspaceId, spaceId },
          {
            jobId,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
        jobIds.push(jobId);
      }
      return {
        action: input.action,
        queuedSpaceCount: jobIds.length,
        jobIds,
      };
    }

    const spaceIds = uniqueValues(input.spaceIds);
    const jobIds: string[] = [];
    for (const spaceId of spaceIds) {
      const jobId = buildKnowledgeAdminActionJobId({
        action: input.action,
        workspaceId: input.workspaceId,
        spaceId,
      });
      await this.knowledgeQueue.add(
        input.action === 'reindex_access'
          ? QueueJob.KNOWLEDGE_REINDEX_ACCESS
          : QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
        {
          workspaceId: input.workspaceId,
          spaceId,
        },
        { jobId },
      );
      jobIds.push(jobId);
    }

    return {
      action: input.action,
      queuedSpaceCount: jobIds.length,
      jobIds,
    };
  }
}

function hashQuery(query: string): string {
  return `sha256:${createHash('sha256').update(query).digest('hex')}`;
}

function isModelConfigFeature(value: string): value is AiModelConfigFeature {
  return (
    value === 'compiler' ||
    value === 'answer' ||
    value === 'image' ||
    value === 'embedding'
  );
}

/**
 * Citation records are also consumed by external Skills. Keep internal
 * citation construction path-relative, but expose links using the configured
 * browser-facing APP_URL at the HTTP boundary. This avoids callers resolving
 * `/p/...` against the API listener (which may be a private backend port).
 */
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
