import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { ContextualWorkerHost } from '../../../common/logger/contextual-worker.host';
import { Job } from 'bullmq';
import { AttachmentService } from '../services/attachment.service';
import { QueueJob, QueueName } from 'src/integrations/queue/constants';
import { ModuleRef } from '@nestjs/core';

@Processor(QueueName.ATTACHMENT_QUEUE)
export class AttachmentProcessor
  extends ContextualWorkerHost
  implements OnModuleDestroy
{
  private readonly logger = new Logger(AttachmentProcessor.name);
  constructor(
    private readonly attachmentService: AttachmentService,
    private moduleRef: ModuleRef,
  ) {
    super();
  }

  async handle(job: Job<any, void>): Promise<void> {
    if (job.name === QueueJob.DELETE_SPACE_ATTACHMENTS) {
      await this.attachmentService.handleDeleteSpaceAttachments(job.data.id);
    }
    if (job.name === QueueJob.DELETE_USER_AVATARS) {
      await this.attachmentService.handleDeleteUserAvatars(job.data.id);
    }
    if (job.name === QueueJob.DELETE_PAGE_ATTACHMENTS) {
      await this.attachmentService.handleDeletePageAttachments(job.data.pageId);
    }
    if (job.name === QueueJob.DELETE_AI_CHAT_ATTACHMENTS) {
      await this.attachmentService.handleDeleteAiChatAttachments(
        job.data.aiChatId,
      );
    }
    if (
      job.name === QueueJob.ATTACHMENT_INDEX_CONTENT ||
      job.name === QueueJob.ATTACHMENT_INDEXING
    ) {
      let AttachmentEeModule: any;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        AttachmentEeModule = require('./../../../ee/attachments-ee/attachment-ee.service');
      } catch {
        this.logger.debug(
          { jobName: job.name },
          'EE module not bundled, skipping attachment indexing',
        );
        return;
      }
      const attachmentEeService = this.moduleRef.get(
        AttachmentEeModule.AttachmentEeService,
        { strict: false },
      );

      if (job.name === QueueJob.ATTACHMENT_INDEX_CONTENT) {
        await attachmentEeService.indexAttachment(job.data.attachmentId);
      } else if (job.name === QueueJob.ATTACHMENT_INDEXING) {
        await attachmentEeService.indexAttachments(job.data.workspaceId);
      }
    }
  }

  @OnWorkerEvent('failed')
  onError(job: Job) {
    const fields = {
      jobId: job.id,
      jobName: job.name,
      attachmentId: job.data?.attachmentId,
      reason: job.failedReason,
    };

    if (job.name === QueueJob.ATTACHMENT_INDEX_CONTENT) {
      this.logger.debug(fields, 'Attachment job failed');
    } else {
      this.logger.error(fields, 'Attachment job failed');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}
