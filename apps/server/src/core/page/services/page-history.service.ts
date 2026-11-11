import { Injectable, Logger } from '@nestjs/common';
import { PageHistoryRepo } from '@akasha/db/repos/page/page-history.repo';
import { PageHistory, User } from '@akasha/db/types/entity.types';
import { PaginationOptions } from '@akasha/db/pagination/pagination-options';
import { CursorPaginationResult } from '@akasha/db/pagination/cursor-pagination';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { IPageHistoryDiffJob } from '../../../integrations/queue/constants/queue.interface';
import {
  HISTORY_DIFF_ALGORITHM_VERSION,
  HISTORY_DIFF_SCHEMA_VERSION,
} from '@docmost/editor-ext';
import {
  HistorySnapshotResult,
  HistorySnapshotService,
} from '../../../collaboration/services/history-snapshot.service';

@Injectable()
export class PageHistoryService {
  private readonly logger = new Logger(PageHistoryService.name);

  constructor(
    private readonly pageHistoryRepo: PageHistoryRepo,
    @InjectQueue(QueueName.HISTORY_DIFF_QUEUE)
    private readonly historyDiffQueue: Queue,
    private readonly historySnapshot: HistorySnapshotService,
  ) {}

  async createSnapshot(
    pageId: string,
    user: User,
  ): Promise<HistorySnapshotResult> {
    return this.historySnapshot.createSnapshot(pageId, user);
  }

  async findById(historyId: string): Promise<PageHistory> {
    return await this.pageHistoryRepo.findById(historyId, {
      includeContent: true,
    });
  }

  async findHistoryByPageId(
    pageId: string,
    paginationOptions: PaginationOptions,
  ): Promise<CursorPaginationResult<PageHistory>> {
    return this.pageHistoryRepo.findPageHistoryByPageId(
      pageId,
      paginationOptions,
    );
  }

  async findMetadataById(historyId: string): Promise<PageHistory> {
    return this.pageHistoryRepo.findById(historyId);
  }

  async getOrCreateDiff(history: PageHistory) {
    let diff = await this.pageHistoryRepo.findDiffByTargetHistoryId(
      history.id,
      HISTORY_DIFF_ALGORITHM_VERSION,
      HISTORY_DIFF_SCHEMA_VERSION,
    );
    let fromTitle: string | null = null;

    if (!diff) {
      const previousHistory =
        await this.pageHistoryRepo.findPreviousHistory(history);
      if (!previousHistory) {
        return {
          status: 'ready',
          fromHistoryId: null,
          toHistoryId: history.id,
          algorithmVersion: HISTORY_DIFF_ALGORITHM_VERSION,
          schemaVersion: HISTORY_DIFF_SCHEMA_VERSION,
          changes: [],
          addedCount: 0,
          deletedCount: 0,
        };
      }

      fromTitle = previousHistory.title ?? null;
      await this.pageHistoryRepo.createPendingDiff({
        fromHistoryId: previousHistory.id,
        toHistoryId: history.id,
        algorithmVersion: HISTORY_DIFF_ALGORITHM_VERSION,
        schemaVersion: HISTORY_DIFF_SCHEMA_VERSION,
      });
      diff = await this.pageHistoryRepo.findDiffByTargetHistoryId(
        history.id,
        HISTORY_DIFF_ALGORITHM_VERSION,
        HISTORY_DIFF_SCHEMA_VERSION,
      );
    }

    if (!diff) {
      throw new Error('Failed to create page history diff record');
    }

    if (fromTitle === null && diff.fromHistoryId) {
      const fromHistory = await this.pageHistoryRepo.findById(
        diff.fromHistoryId,
      );
      fromTitle = fromHistory?.title ?? null;
    }

    if (diff?.status === 'pending') {
      await this.enqueueDiff(
        diff.fromHistoryId,
        diff.toHistoryId,
        diff.algorithmVersion,
      ).catch((error) => {
        this.logger.error(
          `Failed to queue history diff for ${diff.toHistoryId}: ${error.message}`,
        );
      });
    }

    return {
      status: diff.status,
      fromHistoryId: diff.fromHistoryId,
      fromTitle,
      toHistoryId: diff.toHistoryId,
      algorithmVersion: diff.algorithmVersion,
      schemaVersion: diff.schemaVersion,
      fromContentHash: diff.fromContentHash,
      toContentHash: diff.toContentHash,
      changes: diff.changes ?? [],
      addedCount: diff.addedCount,
      deletedCount: diff.deletedCount,
      errorCode: diff.errorCode,
    };
  }

  private async enqueueDiff(
    fromHistoryId: string,
    toHistoryId: string,
    algorithmVersion: string,
  ): Promise<void> {
    await this.historyDiffQueue.add(
      QueueJob.PAGE_HISTORY_DIFF,
      {
        fromHistoryId,
        toHistoryId,
        algorithmVersion,
      } as IPageHistoryDiffJob,
      {
        jobId: `history-diff-${toHistoryId}-${algorithmVersion}`,
      },
    );
  }
}
