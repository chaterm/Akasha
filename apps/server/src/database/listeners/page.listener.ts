import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { Queue } from 'bullmq';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { PageRepo } from '../repos/page/page.repo';
import {
  buildKnowledgeCompileCoalesceKey,
  buildKnowledgeCompilePageJobId,
  KNOWLEDGE_COMPILE_DELAY_MS,
} from '../../ee/llm-wiki/services/knowledge-queue.utils';

export class PageEvent {
  pageIds: string[];
  workspaceId: string;
}

@Injectable()
export class PageListener {
  private readonly logger = new Logger(PageListener.name);

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly pageRepo: PageRepo,
    @InjectQueue(QueueName.SEARCH_QUEUE) private searchQueue: Queue,
    @InjectQueue(QueueName.AI_QUEUE) private aiQueue: Queue,
  ) {}

  @OnEvent(EventName.PAGE_CREATED)
  async handlePageCreated(event: PageEvent) {
    const { pageIds, workspaceId } = event;
    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_CREATED, {
        pageIds,
      });
    }

    await this.aiQueue.add(QueueJob.PAGE_CREATED, { pageIds, workspaceId });
    await this.enqueueKnowledgeAccessReindex(workspaceId, pageIds);
    await this.enqueueKnowledgeCompileForPages(workspaceId, pageIds);
  }

  @OnEvent(EventName.PAGE_UPDATED)
  async handlePageUpdated(event: PageEvent) {
    const { pageIds, workspaceId } = event;

    await this.searchQueue.add(QueueJob.PAGE_UPDATED, { pageIds });
    await this.enqueueKnowledgeAccessReindex(workspaceId, pageIds);
    await this.enqueueKnowledgeCompileForPages(workspaceId, pageIds);
  }

  @OnEvent(EventName.PAGE_DELETED)
  async handlePageDeleted(event: PageEvent) {
    const { pageIds, workspaceId } = event;
    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_DELETED, { pageIds });
    }

    await this.enqueueKnowledgeSourceInvalidation(workspaceId, pageIds);
    await this.aiQueue.add(QueueJob.PAGE_DELETED, { pageIds, workspaceId });
  }

  @OnEvent(EventName.PAGE_SOFT_DELETED)
  async handlePageSoftDeleted(event: PageEvent) {
    const { pageIds, workspaceId } = event;

    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_SOFT_DELETED, { pageIds });
    }

    await this.enqueueKnowledgeSourceInvalidation(workspaceId, pageIds);
    await this.aiQueue.add(QueueJob.PAGE_SOFT_DELETED, {
      pageIds,
      workspaceId,
    });
  }

  @OnEvent(EventName.PAGE_RESTORED)
  async handlePageRestored(event: PageEvent) {
    const { pageIds, workspaceId } = event;
    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_RESTORED, { pageIds });
    }

    await this.aiQueue.add(QueueJob.PAGE_RESTORED, { pageIds, workspaceId });
    await this.enqueueKnowledgeSourceInvalidation(
      workspaceId,
      pageIds,
      'source_artifacts',
    );
    await this.enqueueKnowledgeAccessReindex(workspaceId, pageIds);
    await this.enqueueKnowledgeCompileForPages(workspaceId, pageIds);
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

    await this.aiQueue.add(QueueJob.KNOWLEDGE_MARK_SOURCES_STALE, {
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

    await this.aiQueue.add(QueueJob.KNOWLEDGE_REINDEX_ACCESS, {
      workspaceId,
      sourcePageIds: pageIds,
    });
  }

  private async enqueueKnowledgeCompileForPages(
    workspaceId: string,
    pageIds: string[],
  ): Promise<void> {
    if (!workspaceId || pageIds.length === 0) return;

    const pageRefs = await this.pageRepo.findExistingPageRefs({
      workspaceId,
      pageIds,
    });

    for (const page of pageRefs) {
      if (page.deletedAt) continue;
      await this.aiQueue.add(
        QueueJob.KNOWLEDGE_COMPILE_PAGES,
        {
          workspaceId,
          spaceId: page.spaceId,
          sourcePageIds: [page.id],
        },
        {
          delay: KNOWLEDGE_COMPILE_DELAY_MS,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          jobId: buildKnowledgeCompilePageJobId({
            workspaceId,
            spaceId: page.spaceId,
            sourcePageId: page.id,
            runKey: buildKnowledgeCompileCoalesceKey(),
          }),
        },
      );
    }
  }
}
