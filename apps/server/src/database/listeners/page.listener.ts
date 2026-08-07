import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { Queue } from 'bullmq';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { KnowledgeSpaceCompilationRepo } from '../repos/llm-wiki/knowledge-space-compilation.repo';
import {
  DEFAULT_KNOWLEDGE_COMPILER_VERSION,
  KNOWLEDGE_PAGE_COMPILE_QUIET_PERIOD_MS,
  DEFAULT_KNOWLEDGE_PROMPT_VERSION,
} from '../../ee/llm-wiki/llm-wiki.constants';

export class PageEvent {
  pageIds: string[];
  workspaceId: string;
  skipKnowledgeCompile?: boolean;
}

@Injectable()
export class PageListener {
  private readonly logger = new Logger(PageListener.name);

  constructor(
    private readonly environmentService: EnvironmentService,
    @InjectQueue(QueueName.SEARCH_QUEUE) private searchQueue: Queue,
    @InjectQueue(QueueName.KNOWLEDGE_TEXT_QUEUE)
    private knowledgeQueue: Queue,
    private readonly runRepo: KnowledgeSpaceCompilationRepo,
  ) {}

  @OnEvent(EventName.PAGE_CREATED)
  async handlePageCreated(event: PageEvent) {
    const { pageIds, workspaceId } = event;
    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_CREATED, {
        pageIds,
      });
    }

    await this.enqueueKnowledgeAccessReindex(workspaceId, pageIds);
    if (!event.skipKnowledgeCompile) {
      await this.scheduleKnowledgeRuns(workspaceId, pageIds, 'page_created');
    }
  }

  @OnEvent(EventName.PAGE_UPDATED)
  async handlePageUpdated(event: PageEvent) {
    const { pageIds, workspaceId } = event;

    await this.searchQueue.add(QueueJob.PAGE_UPDATED, { pageIds });
    await this.enqueueKnowledgeAccessReindex(workspaceId, pageIds);
    // A regular edit is a cheap no-op here. A cross-Space move is detected by
    // comparing current page ownership with persisted contribution scopes and
    // retires only the old-Space contributions.
    await this.enqueueKnowledgeSourceRetirement(workspaceId, pageIds);
    if (!event.skipKnowledgeCompile) {
      await this.scheduleKnowledgeRuns(workspaceId, pageIds, 'page_updated');
    }
  }

  @OnEvent(EventName.PAGE_DELETED)
  async handlePageDeleted(event: PageEvent) {
    const { pageIds, workspaceId } = event;
    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_DELETED, { pageIds });
    }

    await this.enqueueKnowledgeSourceRetirement(workspaceId, pageIds);
  }

  @OnEvent(EventName.PAGE_SOFT_DELETED)
  async handlePageSoftDeleted(event: PageEvent) {
    const { pageIds, workspaceId } = event;

    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_SOFT_DELETED, { pageIds });
    }

    await this.enqueueKnowledgeSourceRetirement(workspaceId, pageIds);
  }

  @OnEvent(EventName.PAGE_RESTORED)
  async handlePageRestored(event: PageEvent) {
    const { pageIds, workspaceId } = event;
    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_RESTORED, { pageIds });
    }

    await this.enqueueKnowledgeSourceInvalidation(
      workspaceId,
      pageIds,
      'source_artifacts',
    );
    await this.enqueueKnowledgeAccessReindex(workspaceId, pageIds);
    await this.requestKnowledgeRuns(workspaceId, pageIds, false);
  }

  isTypesense(): boolean {
    return this.environmentService.getSearchDriver() === 'typesense';
  }

  private async enqueueKnowledgeSourceInvalidation(
    workspaceId: string,
    pageIds: string[],
    mode: 'all_dependencies' | 'source_artifacts' = 'all_dependencies',
  ): Promise<void> {
    if (!workspaceId || pageIds.length === 0) return;

    await this.knowledgeQueue.add(QueueJob.KNOWLEDGE_MARK_SOURCES_STALE, {
      workspaceId,
      sourcePageIds: pageIds,
      ...(mode === 'source_artifacts' ? { mode } : {}),
    });
  }

  private async enqueueKnowledgeAccessReindex(
    workspaceId: string,
    pageIds: string[],
  ): Promise<void> {
    if (!workspaceId || pageIds.length === 0) return;

    await this.knowledgeQueue.add(QueueJob.KNOWLEDGE_REINDEX_ACCESS, {
      workspaceId,
      sourcePageIds: pageIds,
    });
  }

  private async enqueueKnowledgeSourceRetirement(
    workspaceId: string,
    pageIds: string[],
  ): Promise<void> {
    if (!workspaceId || pageIds.length === 0) return;
    await this.knowledgeQueue.add(
      QueueJob.KNOWLEDGE_RETIRE_SOURCES,
      {
        workspaceId,
        sourcePageIds: [...new Set(pageIds)],
      },
      {
        // PageRepo can emit from a caller-owned transaction. A small delay
        // makes the worker observe the committed delete/move state.
        delay: 1_000,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: true,
      },
    );
  }

  private async requestKnowledgeRuns(
    workspaceId: string,
    pageIds: string[],
    removed: boolean,
  ): Promise<void> {
    if (!workspaceId || pageIds.length === 0) return;

    await this.runRepo.requestIncrementalCompileForPages({
      workspaceId,
      sourcePageIds: pageIds,
      trigger: 'page_update',
      removed,
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
    });
  }

  private async scheduleKnowledgeRuns(
    workspaceId: string,
    pageIds: string[],
    trigger: 'page_created' | 'page_updated',
  ): Promise<void> {
    if (!workspaceId || pageIds.length === 0) return;

    const scheduledPageCount =
      await this.runRepo.scheduleIncrementalCompileForPages({
        workspaceId,
        sourcePageIds: pageIds,
        trigger,
        quietPeriodMs: KNOWLEDGE_PAGE_COMPILE_QUIET_PERIOD_MS,
      });
    this.logger.log({
      event: 'knowledge_pages_debounce_scheduled',
      trigger,
      requestedPageCount: pageIds.length,
      scheduledPageCount,
    });
  }
}
