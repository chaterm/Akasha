import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { User, Workspace } from '@akasha/db/types/entity.types';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { UserRole } from '../../../common/helpers/types/permission';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { isKnowledgeAiEnabledForWorkspace } from '../services/ai-knowledge-chat.service';
import {
  buildReviewDiscoverJobId,
  buildReviewNegotiateJobId,
} from '../services/knowledge-queue.utils';
import { isDeepSearch, isSkip, ResolvedReview } from './approval';
import {
  NegotiationTurn,
  ReviewJob,
  ReviewJobResult,
  ReviewSnapshot,
  reviewItemSchema,
} from './review.schema';
import { DiscoverReviewDto } from './dto/discover-review.dto';
import { LoadReviewDto } from './dto/load-review.dto';
import { NegotiateReviewDto } from './dto/negotiate-review.dto';
import { PlanReviewDto } from './dto/plan-review.dto';
import { ReviewApplyService } from './review-apply.service';
import { ReviewSnapshotService } from './review-snapshot.service';

@UseGuards(JwtAuthGuard)
@Controller('llm-wiki/review')
export class ReviewController {
  constructor(
    private readonly applyService: ReviewApplyService,
    private readonly snapshotService: ReviewSnapshotService,
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('load')
  async load(
    @Body() dto: LoadReviewDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAiEnabled(workspace);
    this.assertAdmin(user);

    return this.snapshotService.loadSnapshot({
      workspaceId: workspace.id,
      spaceId: dto.spaceId,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('discover')
  async discover(
    @Body() dto: DiscoverReviewDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<ReviewJobResult> {
    this.assertAiEnabled(workspace);
    this.assertAdmin(user);

    const jobId = buildReviewDiscoverJobId({
      workspaceId: workspace.id,
      spaceId: dto.spaceId,
    });
    const { job, isNew } = await this.snapshotService.beginJob({
      workspaceId: workspace.id,
      spaceId: dto.spaceId,
      jobId,
      kind: 'discover',
    });
    if (isNew) {
      await this.enqueueReviewJob(job, QueueJob.REVIEW_DISCOVER, {
        workspaceId: workspace.id,
        spaceId: dto.spaceId,
        limit: dto.limit,
      });
    }
    return { job, result: null };
  }

  @HttpCode(HttpStatus.OK)
  @Post('negotiate')
  async negotiate(
    @Body() dto: NegotiateReviewDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<ResolvedReview | ReviewJobResult> {
    this.assertAiEnabled(workspace);
    this.assertAdmin(user);

    const item = reviewItemSchema.parse(dto.item);
    const feedback = (dto.feedback ?? '').trim();
    const snapshot = await this.snapshotService.loadSnapshot({
      workspaceId: workspace.id,
      spaceId: dto.spaceId,
    });
    assertCurrentReviewItemNotApplied(snapshot, item.id);

    if (isSkip(feedback)) {
      const resolved: ResolvedReview = {
        item,
        feedback,
        skipped: true,
        deepSearched: false,
        searchResults: [],
        draft: null,
        applied: null,
        turns: [],
      };
      await this.snapshotService.saveResolvedReview({
        workspaceId: workspace.id,
        spaceId: dto.spaceId,
        resolved,
      });
      this.auditNegotiation(dto.spaceId, resolved);
      return resolved;
    }

    const jobId = buildReviewNegotiateJobId({
      workspaceId: workspace.id,
      spaceId: dto.spaceId,
      itemId: item.id,
    });
    const { job, isNew } = await this.snapshotService.beginJob({
      workspaceId: workspace.id,
      spaceId: dto.spaceId,
      jobId,
      kind: 'negotiate',
      itemId: item.id,
    });
    if (isNew) {
      await this.enqueueReviewJob(job, QueueJob.REVIEW_NEGOTIATE, {
        workspaceId: workspace.id,
        spaceId: dto.spaceId,
        item,
        feedback,
      });
    }
    return { job, result: null };
  }

  @Get('jobs/:jobId')
  async getJob(
    @Param('jobId') jobId: string,
    @Query('spaceId') spaceId: string,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<ReviewJobResult> {
    this.assertAiEnabled(workspace);
    this.assertAdmin(user);
    if (!spaceId) {
      throw new BadRequestException('spaceId is required');
    }

    const found = await this.snapshotService.getJob({
      workspaceId: workspace.id,
      spaceId,
      jobId,
    });
    if (!found) {
      throw new NotFoundException('Review job not found');
    }
    return buildReviewJobResult(found.snapshot, found.job);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':itemId/plan')
  async plan(
    @Param('itemId') itemId: string,
    @Body() dto: PlanReviewDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAiEnabled(workspace);
    this.assertAdmin(user);

    const snapshot = await this.snapshotService.loadSnapshot({
      workspaceId: workspace.id,
      spaceId: dto.spaceId,
    });
    if (!snapshot) {
      throw new NotFoundException('Review snapshot not found');
    }

    const resolved = snapshot.resolvedReviews.find(
      (entry) => entry.item.id === itemId,
    );
    if (!resolved || !resolved.draft) {
      throw new BadRequestException('Generate a review draft before planning');
    }

    const application = await this.applyService.planDraft({
      workspaceId: workspace.id,
      spaceId: dto.spaceId,
      user,
      item: resolved.item,
      draft: resolved.draft,
      docs: snapshot.docs,
      searchResults: collectResolvedSearchResults(resolved),
    });

    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_REVIEW_PLANNED,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: application.id,
      spaceId: dto.spaceId,
      metadata: {
        reviewItemId: application.reviewItemId,
        operation: application.operation,
        targetPageId: application.targetPageId,
        targetHeadingPath: application.targetHeadingPath,
        sourceRefCount: application.sourceRefs.length,
      },
    });

    return application;
  }

  @HttpCode(HttpStatus.OK)
  @Post('applications/:id/apply')
  async apply(
    @Param('id') applicationId: string,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAiEnabled(workspace);
    this.assertAdmin(user);

    const application = await this.applyService.applyApplication({
      workspaceId: workspace.id,
      user,
      applicationId,
    });

    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_REVIEW_APPLIED,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: application.id,
      spaceId: application.spaceId,
      metadata: {
        reviewItemId: application.reviewItemId,
        operation: application.operation,
        targetPageId: application.targetPageId,
        createdPageId: application.createdPageId,
        targetHeadingPath: application.targetHeadingPath,
      },
    });

    return application;
  }

  @HttpCode(HttpStatus.OK)
  @Post('applications/:id/revert')
  async revert(
    @Param('id') applicationId: string,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAiEnabled(workspace);
    this.assertAdmin(user);

    const application = await this.applyService.revertApplication({
      workspaceId: workspace.id,
      user,
      applicationId,
    });

    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_REVIEW_REVERTED,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: application.id,
      spaceId: application.spaceId,
      metadata: {
        reviewItemId: application.reviewItemId,
        operation: application.operation,
        targetPageId: application.targetPageId,
        createdPageId: application.createdPageId,
      },
    });

    return application;
  }

  @HttpCode(HttpStatus.OK)
  @Get('applications/:id/diff')
  async diff(
    @Param('id') applicationId: string,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAiEnabled(workspace);
    this.assertAdmin(user);

    return this.applyService.getDiff({
      workspaceId: workspace.id,
      applicationId,
    });
  }

  private async enqueueReviewJob(
    job: ReviewJob,
    name: QueueJob.REVIEW_DISCOVER | QueueJob.REVIEW_NEGOTIATE,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.aiQueue.add(name, data, { jobId: job.jobId });
    } catch (error) {
      await this.snapshotService.markJobFailed({
        workspaceId: data.workspaceId as string,
        spaceId: data.spaceId as string,
        jobId: job.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private assertAdmin(user: User): void {
    if (user.role !== UserRole.OWNER && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('LLM wiki review is restricted to admins');
    }
  }

  private assertAiEnabled(workspace: Workspace): void {
    if (!isKnowledgeAiEnabledForWorkspace(workspace)) {
      throw new ForbiddenException('AI knowledge chat is disabled');
    }
  }

  private auditNegotiation(spaceId: string, resolved: ResolvedReview): void {
    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_REVIEW_NEGOTIATED,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: spaceId,
      spaceId,
      metadata: {
        reviewItemId: resolved.item.id,
        reviewItemType: resolved.item.type,
        feedbackKind: classifyFeedback(resolved.feedback),
        skipped: resolved.skipped,
        deepSearched: resolved.deepSearched,
        searchResultCount: resolved.searchResults.length,
        negotiationTurnCount: resolved.turns.length,
        draftApplyOperation: resolved.draft?.applyOperation ?? null,
        hasDraft: Boolean(resolved.draft),
        targetDocId: resolved.draft?.targetDocId ?? null,
        applied: false,
        appliedAction: null,
        appliedPageId: null,
      },
    });
  }
}

function buildReviewJobResult(
  snapshot: ReviewSnapshot,
  job: ReviewJob,
): ReviewJobResult {
  if (job.status !== 'done') {
    return { job, result: null };
  }
  if (job.kind === 'discover') {
    return { job, result: snapshot };
  }
  const resolved = job.itemId
    ? snapshot.resolvedReviews.find((entry) => entry.item.id === job.itemId)
    : null;
  return { job, result: resolved ?? null };
}

function collectResolvedSearchResults(resolved: {
  searchResults: ResolvedReview['searchResults'];
  turns?: NegotiationTurn[];
}): ResolvedReview['searchResults'] {
  const seen = new Set<string>();
  const turns = resolved.turns ?? [];
  const results = [
    ...turns.flatMap((turn) => turn.searchResults),
    ...resolved.searchResults,
  ];
  return results.filter((result) => {
    const key = `${result.url}\n${result.title}\n${result.snippet}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function assertCurrentReviewItemNotApplied(
  snapshot: ReviewSnapshot | null,
  itemId: string,
): void {
  const resolved = snapshot?.resolvedReviews.find(
    (entry) => entry.item.id === itemId,
  );
  if (resolved?.applied) {
    throw new BadRequestException(
      'Review item has already been applied to the wiki',
    );
  }
}

function classifyFeedback(
  feedback: string,
): 'skip' | 'deep_search' | 'accept' | 'free_text' {
  if (isSkip(feedback)) return 'skip';
  if (isDeepSearch(feedback)) return 'deep_search';
  return feedback.trim() === '采纳' ? 'accept' : 'free_text';
}
