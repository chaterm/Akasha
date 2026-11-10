import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { isDeepStrictEqual } from 'node:util';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import {
  IPageBacklinkJob,
  IPageHistoryDiffJob,
  IPageUpdateNotificationJob,
} from '../../integrations/queue/constants/queue.interface';
import {
  extractMentions,
  extractPageMentions,
  extractInternalLinkSlugIds,
} from '../../common/helpers/prosemirror/utils';
import { PageHistoryRepo } from '@akasha/db/repos/page/page-history.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { Page, PageHistory, User } from '@akasha/db/types/entity.types';
import {
  HISTORY_DIFF_ALGORITHM_VERSION,
  HISTORY_DIFF_SCHEMA_VERSION,
} from '@docmost/editor-ext';
import { CollaborationGateway } from '../collaboration.gateway';
import { CollabHistoryService } from './collab-history.service';
import { WatcherService } from '../../core/watcher/watcher.service';

export type HistorySnapshotResult = Omit<PageHistory, 'content'> & {
  created: boolean;
};

@Injectable()
export class HistorySnapshotService {
  private readonly logger = new Logger(HistorySnapshotService.name);

  constructor(
    private readonly pageHistoryRepo: PageHistoryRepo,
    private readonly pageRepo: PageRepo,
    private readonly collabHistory: CollabHistoryService,
    private readonly watcherService: WatcherService,
    private readonly collaborationGateway: CollaborationGateway,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE) private notificationQueue: Queue,
    @InjectQueue(QueueName.GENERAL_QUEUE) private generalQueue: Queue,
    @InjectQueue(QueueName.HISTORY_DIFF_QUEUE) private historyDiffQueue: Queue,
  ) {}

  async createSnapshot(
    pageId: string,
    user: User,
  ): Promise<HistorySnapshotResult> {
    const liveContent = await this.collaborationGateway.getDocumentJson(
      `page.${pageId}`,
      user,
    );

    const page = await this.pageRepo.findById(pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    const lastHistory = await this.pageHistoryRepo.findPageLastHistory(pageId, {
      includeContent: true,
    });
    const contentChanged =
      !lastHistory || !isDeepStrictEqual(lastHistory.content, liveContent);
    const titleChanged =
      !!lastHistory && (lastHistory.title ?? '') !== (page.title ?? '');

    if (!contentChanged && !titleChanged) {
      const { content: _content, ...metadata } = lastHistory;
      return { ...metadata, created: false };
    }

    const pendingContributorIds =
      await this.collabHistory.popContributors(pageId);
    const contributorIds = Array.from(
      new Set([...pendingContributorIds, user.id]),
    );

    let newHistory: PageHistory;
    try {
      await this.watcherService.addPageWatchers(
        contributorIds,
        pageId,
        page.spaceId,
        page.workspaceId,
      );

      newHistory = await this.pageHistoryRepo.saveHistory(
        { ...page, content: liveContent } as Page,
        { contributorIds },
      );

      if (lastHistory) {
        await this.enqueueHistoryDiff(lastHistory.id, newHistory.id).catch(
          (err) => {
            this.logger.error(
              `Failed to queue history diff for ${newHistory.id}: ${err.message}`,
            );
          },
        );
      }
    } catch (err) {
      await this.collabHistory.addContributors(pageId, pendingContributorIds);
      throw err;
    }

    if (contentChanged) {
      await this.enqueuePostHistoryJobs(
        { ...page, content: liveContent } as Page,
        pendingContributorIds,
        !!lastHistory?.content,
      );
    }

    this.logger.debug(`Manual history snapshot created for page: ${pageId}`);
    const { content: _content, ...metadata } = newHistory;
    return { ...metadata, created: true };
  }

  async enqueueHistoryDiff(
    fromHistoryId: string,
    toHistoryId: string,
  ): Promise<void> {
    await this.pageHistoryRepo.createPendingDiff({
      fromHistoryId,
      toHistoryId,
      algorithmVersion: HISTORY_DIFF_ALGORITHM_VERSION,
      schemaVersion: HISTORY_DIFF_SCHEMA_VERSION,
    });
    await this.historyDiffQueue.add(
      QueueJob.PAGE_HISTORY_DIFF,
      {
        fromHistoryId,
        toHistoryId,
        algorithmVersion: HISTORY_DIFF_ALGORITHM_VERSION,
      } as IPageHistoryDiffJob,
      {
        jobId: `history-diff-${toHistoryId}-${HISTORY_DIFF_ALGORITHM_VERSION}`,
      },
    );
  }

  async enqueuePostHistoryJobs(
    page: Page,
    contributorIds: string[],
    hadPreviousContent: boolean,
  ): Promise<void> {
    const pageId = page.id;
    const mentions = extractMentions(page.content);
    const pageMentions = extractPageMentions(mentions);
    const internalLinkSlugIds = extractInternalLinkSlugIds(page.content);

    await this.generalQueue
      .add(QueueJob.PAGE_BACKLINKS, {
        pageId,
        workspaceId: page.workspaceId,
        mentions: pageMentions,
        internalLinkSlugIds,
      } as IPageBacklinkJob)
      .catch((err) => {
        this.logger.error(
          `Failed to queue backlinks for ${pageId}: ${err.message}`,
        );
      });

    if (contributorIds.length > 0 && hadPreviousContent) {
      await this.notificationQueue
        .add(QueueJob.PAGE_UPDATED, {
          pageId,
          spaceId: page.spaceId,
          workspaceId: page.workspaceId,
          actorIds: contributorIds,
        } as IPageUpdateNotificationJob)
        .catch((err) => {
          this.logger.error(
            `Failed to queue page update notification for ${pageId}: ${err.message}`,
          );
        });
    }
  }
}
