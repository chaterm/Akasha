import {
  Body,
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
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
import {
  DEFAULT_KNOWLEDGE_COMPILER_VERSION,
  DEFAULT_KNOWLEDGE_PROMPT_VERSION,
} from './llm-wiki.constants';
import { AdminKnowledgeSpaceActionDto } from './dto/admin-space-action.dto';
import { CompileSpacesDto } from './dto/compile-spaces.dto';
import { CancelKnowledgeRunDto } from './dto/cancel-knowledge-run.dto';
import {
  AdminKnowledgePageLogDto,
  AdminKnowledgeQuarantineListDto,
  AdminKnowledgeRunListDto,
  AdminKnowledgeRunPagesQueryDto,
  AdminKnowledgeRunSummaryDto,
} from './dto/admin-diagnostics.dto';
import { AdminKnowledgeRetryPagesDto } from './dto/admin-retry-pages.dto';
import { ImportCompileResultDto } from './dto/import-compile-result.dto';
import { KnowledgeGraphDto } from './dto/knowledge-graph.dto';
import { KnowledgeSpaceOperationDto } from './dto/knowledge-space-operation.dto';
import { QueryKnowledgeDto } from './dto/query-knowledge.dto';
import { CitationPageDto } from './dto/citation-page.dto';
import { AiKnowledgeChatService } from './services/ai-knowledge-chat.service';
import { KnowledgeDiagnosticsService } from './services/knowledge-diagnostics.service';
import { KnowledgeGraphService } from './services/knowledge-graph.service';
import { KnowledgeImportService } from './services/knowledge-import.service';
import { KnowledgeSourceExporterService } from './services/knowledge-source-exporter.service';
import { KnowledgeSpaceCompilationService } from './services/knowledge-space-compilation.service';
import { KnowledgeSpaceResetService } from './services/knowledge-space-reset.service';
import {
  buildKnowledgeAdminActionJobId,
  uniqueValues,
} from './services/knowledge-queue.utils';
import { KnowledgeAdminSpaceAction } from './types/knowledge-queue.types';
import { getPageTitle } from '../../common/helpers';
import { jsonToMarkdown } from '../../collaboration/collaboration.util';

@UseGuards(JwtAuthGuard)
@Controller('llm-wiki')
export class LlmWikiController {
  constructor(
    private readonly chatService: AiKnowledgeChatService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    private readonly importService: KnowledgeImportService,
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
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('query')
  async queryKnowledge(
    @Body() dto: QueryKnowledgeDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (!this.chatService.isEnabledForWorkspace(workspace)) {
      throw new ForbiddenException('AI knowledge chat is disabled');
    }

    const result = await this.chatService.chat({
      workspaceId: workspace.id,
      userId: user.id,
      query: dto.query,
      spaceIds: dto.spaceIds,
      chatContext: dto.chatContext,
      workspace,
    });
    const queryHash = hashQuery(dto.query);
    const { retrievalDiagnostics, ...response } = result;

    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_QUERY,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: workspace.id,
      metadata: {
        queryHash,
        spaceIds: dto.spaceIds,
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
        origin: 'knowledge_query',
        spaceIds: dto.spaceIds,
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

    return response;
  }

  @HttpCode(HttpStatus.OK)
  @Post('citation-page')
  async getCitationPage(
    @Body() dto: CitationPageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
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

    await this.pageAccessService.validateCanReadCitationSourceWithPermissions(
      page,
      user,
    );

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
      url: `/p/${page.slugId}`,
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
    const retryablePageIds = new Set(
      await this.diagnosticsService.findRetryableFailedPageIds({
        workspaceId: workspace.id,
        sourcePageIds: pageIds,
      }),
    );
    if (pageIds.some((pageId) => !retryablePageIds.has(pageId))) {
      throw new BadRequestException(
        'Only currently failed knowledge pages can be retried',
      );
    }

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
  @Post('admin/import-compile-result')
  async importCompileResult(
    @Body() dto: ImportCompileResultDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (!this.chatService.isEnabledForWorkspace(workspace)) {
      throw new ForbiddenException('AI knowledge chat is disabled');
    }

    this.assertAdmin(user, 'AI knowledge import is restricted to admins');

    const result = await this.importService.importCompileResult({
      input: {
        workspaceId: workspace.id,
        spaceId: dto.spaceId,
        compilerVersion:
          dto.compilerVersion ?? DEFAULT_KNOWLEDGE_COMPILER_VERSION,
        promptVersion: dto.promptVersion ?? DEFAULT_KNOWLEDGE_PROMPT_VERSION,
        sources: dto.sources,
      },
      artifacts: dto.artifacts,
    });

    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_IMPORT,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: dto.spaceId,
      metadata: {
        artifactCount: dto.artifacts.length,
        sourceCount: dto.sources.length,
        importedArtifactCount: result.importedArtifactCount,
        quarantinedArtifactCount: result.quarantinedArtifactCount,
      },
    });

    return result;
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
