import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { ContextualWorkerHost } from '../../../common/logger/contextual-worker.host';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../constants';
import {
  IAddPageWatchersJob,
  IPageBacklinkJob,
} from '../constants/queue.interface';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { BacklinkRepo } from '@akasha/db/repos/backlink/backlink.repo';
import {
  WatcherRepo,
  WatcherType,
} from '@akasha/db/repos/watcher/watcher.repo';
import { InsertableWatcher } from '@akasha/db/types/entity.types';
import { processBacklinks } from '../tasks/backlinks.task';

@Processor(QueueName.GENERAL_QUEUE)
export class GeneralQueueProcessor
  extends ContextualWorkerHost
  implements OnModuleDestroy
{
  private readonly logger = new Logger(GeneralQueueProcessor.name);
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly backlinkRepo: BacklinkRepo,
    private readonly watcherRepo: WatcherRepo,
  ) {
    super();
  }

  async handle(job: Job): Promise<void> {
    switch (job.name) {
      case QueueJob.ADD_PAGE_WATCHERS: {
        const { userIds, pageId, spaceId, workspaceId } =
          job.data as IAddPageWatchersJob;
        const watchers: InsertableWatcher[] = userIds.map((userId) => ({
          userId,
          pageId,
          spaceId,
          workspaceId,
          type: WatcherType.PAGE,
          addedById: userId,
        }));
        await this.watcherRepo.insertMany(watchers);
        break;
      }

      case QueueJob.PAGE_BACKLINKS: {
        await processBacklinks(
          this.db,
          this.backlinkRepo,
          job.data as IPageBacklinkJob,
        );
        break;
      }
    }
  }

  @OnWorkerEvent('failed')
  onError(job: Job) {
    this.logger.error(
      { jobId: job.id, jobName: job.name, reason: job.failedReason },
      'Job failed',
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}
