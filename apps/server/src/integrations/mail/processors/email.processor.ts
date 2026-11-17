import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { ContextualWorkerHost } from '../../../common/logger/contextual-worker.host';
import { QueueName } from '../../queue/constants';
import { Job } from 'bullmq';
import { MailService } from '../mail.service';
import { MailMessage } from '../interfaces/mail.message';
import { NotificationRepo } from '@akasha/db/repos/notification/notification.repo';

@Processor(QueueName.EMAIL_QUEUE)
export class EmailProcessor
  extends ContextualWorkerHost
  implements OnModuleDestroy
{
  private readonly logger = new Logger(EmailProcessor.name);
  constructor(
    private readonly mailService: MailService,
    private readonly notificationRepo: NotificationRepo,
  ) {
    super();
  }

  async handle(job: Job<MailMessage, void>): Promise<void> {
    await this.mailService.sendEmail(job.data);

    if (job.data.notificationId) {
      try {
        await this.notificationRepo.markAsEmailed(job.data.notificationId);
      } catch (err) {
        this.logger.warn(
          { notificationId: job.data.notificationId, err },
          'Failed to mark notification as emailed',
        );
      }
    }
  }

  @OnWorkerEvent('failed')
  onError(job: Job) {
    this.logger.error(
      { jobId: job.id, jobName: job.name, reason: job.failedReason },
      'Email job failed',
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}
