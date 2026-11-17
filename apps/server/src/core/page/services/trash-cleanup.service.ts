import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { WithJobContext } from '../../../common/logger/with-job-context.decorator';

const DEFAULT_RETENTION_DAYS = 30;

@Injectable()
export class TrashCleanupService {
  private readonly logger = new Logger(TrashCleanupService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.ATTACHMENT_QUEUE) private attachmentQueue: Queue,
  ) {}

  @Interval('trash-cleanup', 24 * 60 * 60 * 1000)
  @WithJobContext('trash-cleanup')
  async cleanupOldTrash() {
    try {
      const workspaces = await this.db
        .selectFrom('workspaces')
        .select(['id', 'trashRetentionDays'])
        .where('deletedAt', 'is', null)
        .execute();

      let totalCleaned = 0;

      for (const workspace of workspaces) {
        const retentionDays = Number(
          workspace.trashRetentionDays ?? DEFAULT_RETENTION_DAYS,
        );

        const retentionDate = new Date();
        retentionDate.setDate(retentionDate.getDate() - retentionDays);

        const oldDeletedPages = await this.db
          .selectFrom('pages')
          .select(['id'])
          .where('workspaceId', '=', workspace.id)
          .where('deletedAt', '<', retentionDate)
          .execute();

        for (const page of oldDeletedPages) {
          try {
            await this.cleanupPage(page.id);
            totalCleaned++;
          } catch (error) {
            this.logger.error(
              { pageId: page.id, err: error },
              'Failed to cleanup page',
            );
          }
        }
      }

      this.logger.debug(
        totalCleaned > 0
          ? `Trash cleanup completed: ${totalCleaned} pages cleaned`
          : 'No old trash items to clean up',
      );
    } catch (error) {
      this.logger.error(
        'Trash cleanup job failed',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async cleanupPage(pageId: string) {
    const descendants = await this.db
      .withRecursive('page_descendants', (db) =>
        db
          .selectFrom('pages')
          .select(['id'])
          .where('id', '=', pageId)
          .unionAll((exp) =>
            exp
              .selectFrom('pages as p')
              .select(['p.id'])
              .innerJoin('page_descendants as pd', 'pd.id', 'p.parentPageId'),
          ),
      )
      .selectFrom('page_descendants')
      .selectAll()
      .execute();

    const pageIds = descendants.map((d) => d.id);

    for (const id of pageIds) {
      await this.attachmentQueue.add(
        QueueJob.DELETE_PAGE_ATTACHMENTS,
        {
          pageId: id,
        },
        {
          jobId: `delete-page-attachments-${id}`,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
        },
      );
    }

    try {
      if (pageIds.length > 0) {
        await this.db.deleteFrom('pages').where('id', 'in', pageIds).execute();
      }
    } catch (error) {
      this.logger.warn(
        { err: error },
        'Pages may have already been deleted by another node',
      );
    }
  }
}
