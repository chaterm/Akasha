import {
  Body,
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
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
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UserRole } from '../../common/helpers/types/permission';
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
import { AdminKnowledgeDiagnosticsDto } from './dto/admin-diagnostics.dto';
import { AdminKnowledgeRetryPagesDto } from './dto/admin-retry-pages.dto';
import { ImportCompileResultDto } from './dto/import-compile-result.dto';
import { KnowledgeGraphDto } from './dto/knowledge-graph.dto';
import { QueryKnowledgeDto } from './dto/query-knowledge.dto';
import { AiKnowledgeChatService } from './services/ai-knowledge-chat.service';
import { KnowledgeDiagnosticsService } from './services/knowledge-diagnostics.service';
import { KnowledgeGraphService } from './services/knowledge-graph.service';
import { KnowledgeImportService } from './services/knowledge-import.service';
import {
  buildKnowledgeAdminActionJobId,
  buildKnowledgeCompileJobId,
  buildKnowledgeCompilePageJobId,
  buildKnowledgeRunKey,
  uniqueValues,
} from './services/knowledge-queue.utils';
import {
  KnowledgeAdminSpaceAction,
  KnowledgeCompileTrigger,
} from './types/knowledge-queue.types';

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
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
    private readonly pageRepo: PageRepo,
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

    const result = await this.enqueueCompileSpaces({
      workspaceId: workspace.id,
      spaceIds: dto.spaceIds,
      trigger: 'manual_compile',
    });

    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_COMPILE_QUEUED,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: workspace.id,
      metadata: {
        spaceIds: uniqueValues(dto.spaceIds),
        queuedSpaceCount: result.queuedSpaceCount,
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
  @Post('admin/diagnostics')
  async getDiagnostics(
    @Body() dto: AdminKnowledgeDiagnosticsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (!this.chatService.isEnabledForWorkspace(workspace)) {
      throw new ForbiddenException('AI knowledge chat is disabled');
    }

    this.assertAdmin(user, 'AI knowledge diagnostics is restricted to admins');

    return this.diagnosticsService.getWorkspaceDiagnostics({
      workspaceId: workspace.id,
      spaceIds: dto.spaceIds,
      statuses: dto.statuses,
      stages: dto.stages,
      limit: dto.limit,
    });
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

    const runKey = buildKnowledgeRunKey('retry_compile');
    const jobIds: string[] = [];
    for (const pageId of pageIds) {
      const page = pageById.get(pageId) as (typeof pageRefs)[number];
      const jobId = buildKnowledgeCompilePageJobId({
        workspaceId: workspace.id,
        spaceId: page.spaceId,
        sourcePageId: page.id,
        runKey,
      });
      await this.aiQueue.add(
        QueueJob.KNOWLEDGE_COMPILE_PAGES,
        {
          workspaceId: workspace.id,
          spaceId: page.spaceId,
          sourcePageIds: [page.id],
          trigger: 'retry_compile',
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          jobId,
        },
      );
      jobIds.push(jobId);
    }

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

  private async enqueueCompileSpaces(input: {
    workspaceId: string;
    spaceIds: string[];
    trigger: KnowledgeCompileTrigger;
  }): Promise<{ queuedSpaceCount: number; jobIds: string[] }> {
    const spaceIds = uniqueValues(input.spaceIds);
    const jobIds: string[] = [];

    for (const spaceId of spaceIds) {
      const jobId = buildKnowledgeCompileJobId({
        workspaceId: input.workspaceId,
        spaceId,
        runKey: buildKnowledgeRunKey(input.trigger),
      });
      await this.aiQueue.add(
        QueueJob.KNOWLEDGE_COMPILE_SPACE,
        {
          workspaceId: input.workspaceId,
          spaceId,
          trigger: input.trigger,
        },
        { jobId },
      );
      jobIds.push(jobId);
    }

    return { queuedSpaceCount: jobIds.length, jobIds };
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
      const result = await this.enqueueCompileSpaces({
        workspaceId: input.workspaceId,
        spaceIds: input.spaceIds,
        trigger: 'retry_compile',
      });
      return { action: input.action, ...result };
    }

    if (input.action === 'rebuild_embeddings') {
      const result = await this.enqueueCompileSpaces({
        workspaceId: input.workspaceId,
        spaceIds: input.spaceIds,
        trigger: 'rebuild_embeddings',
      });
      return { action: input.action, ...result };
    }

    const spaceIds = uniqueValues(input.spaceIds);
    const jobIds: string[] = [];
    for (const spaceId of spaceIds) {
      const jobId = buildKnowledgeAdminActionJobId({
        action: input.action,
        workspaceId: input.workspaceId,
        spaceId,
      });
      await this.aiQueue.add(
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
