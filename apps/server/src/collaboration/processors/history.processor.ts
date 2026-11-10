import { Logger, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import {
  IPageHistoryDiffJob,
  IPageHistoryJob,
} from '../../integrations/queue/constants/queue.interface';
import { PageHistoryRepo } from '@akasha/db/repos/page/page-history.repo';
import { JsonValue } from '@akasha/db/types/db';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { isDeepStrictEqual } from 'node:util';
import { CollabHistoryService } from '../services/collab-history.service';
import { WatcherService } from '../../core/watcher/watcher.service';
import { HistorySnapshotService } from '../services/history-snapshot.service';
import { isEmptyParagraphDoc } from '../collaboration.util';
import {
  HISTORY_DIFF_ALGORITHM_VERSION,
  HISTORY_DIFF_SCHEMA_VERSION,
  HistoryDiffResult,
} from '@docmost/editor-ext';
import { Worker as NodeWorker } from 'node:worker_threads';
import { resolve } from 'node:path';

@Processor(QueueName.HISTORY_QUEUE)
export class HistoryProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(HistoryProcessor.name);

  constructor(
    private readonly pageHistoryRepo: PageHistoryRepo,
    private readonly pageRepo: PageRepo,
    private readonly collabHistory: CollabHistoryService,
    private readonly watcherService: WatcherService,
    private readonly historySnapshot: HistorySnapshotService,
  ) {
    super();
  }

  async process(job: Job<IPageHistoryJob, void>): Promise<void> {
    if (job.name !== QueueJob.PAGE_HISTORY) return;

    try {
      const { pageId } = job.data;

      const page = await this.pageRepo.findById(pageId, {
        includeContent: true,
      });

      if (!page) {
        this.logger.warn(`Page ${pageId} not found, skipping history`);
        await this.collabHistory.clearContributors(pageId);
        return;
      }

      const lastHistory = await this.pageHistoryRepo.findPageLastHistory(
        pageId,
        { includeContent: true },
      );

      if (!lastHistory && isEmptyParagraphDoc(page.content as any)) {
        this.logger.debug(
          `Skipping first history for page ${pageId}: empty content`,
        );
        await this.collabHistory.clearContributors(pageId);
        return;
      }

      if (
        !lastHistory ||
        !isDeepStrictEqual(lastHistory.content, page.content)
      ) {
        const contributorIds = await this.collabHistory.popContributors(pageId);

        try {
          await this.watcherService.addPageWatchers(
            contributorIds,
            pageId,
            page.spaceId,
            page.workspaceId,
          );

          const newHistory = await this.pageHistoryRepo.saveHistory(page, {
            contributorIds,
          });
          this.logger.debug(`History created for page: ${pageId}`);

          if (lastHistory) {
            await this.historySnapshot
              .enqueueHistoryDiff(lastHistory.id, newHistory.id)
              .catch((err) => {
                this.logger.error(
                  `Failed to queue history diff for ${newHistory.id}: ${err.message}`,
                );
              });
          }
        } catch (err) {
          await this.collabHistory.addContributors(pageId, contributorIds);
          throw err;
        }

        await this.historySnapshot.enqueuePostHistoryJobs(
          page,
          contributorIds,
          !!lastHistory?.content,
        );
      }
    } catch (err) {
      throw err;
    }
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.debug(`Processing ${job.name} for page: ${job.data.pageId}`);
  }

  @OnWorkerEvent('failed')
  onError(job: Job) {
    this.logger.error(
      `Failed ${job.name} for page: ${job.data.pageId}. Reason: ${job.failedReason}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}

const DIFF_THREAD_PATH = resolve(__dirname, '../workers/diff-thread.worker.js');
const DIFF_TIMEOUT_MS = 120_000;

class DiffWorkerPool {
  private readonly logger = new Logger(DiffWorkerPool.name);
  private worker: NodeWorker | null = null;

  private ensureWorker(): NodeWorker {
    if (!this.worker) {
      this.worker = new NodeWorker(DIFF_THREAD_PATH);
      this.worker.on('exit', (code) => {
        this.logger.warn(`Diff worker exited with code ${code}`);
        this.worker = null;
      });
    }
    return this.worker;
  }

  async runDiff(
    fromContent: unknown,
    toContent: unknown,
  ): Promise<HistoryDiffResult> {
    const w = this.ensureWorker();

    return new Promise<HistoryDiffResult>((rs, rj) => {
      const timer = setTimeout(() => {
        w.terminate();
        this.worker = null;
        rj(new Error('diff_worker_timeout'));
      }, DIFF_TIMEOUT_MS);

      const onMessage = (msg: { ok: boolean; result?: HistoryDiffResult; error?: string }) => {
        clearTimeout(timer);
        w.off('message', onMessage);
        w.off('error', onError);
        if (msg.ok) rs(msg.result!);
        else rj(new Error(msg.error));
      };

      const onError = (err: Error) => {
        clearTimeout(timer);
        w.off('message', onMessage);
        this.worker = null;
        rj(err);
      };

      w.on('message', onMessage);
      w.on('error', onError);
      w.postMessage({ fromContent, toContent });
    });
  }

  async destroy(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }
}

const MAX_HISTORY_DIFF_CONTENT_BYTES = 5 * 1024 * 1024;
const MAX_HISTORY_DIFF_RESULT_BYTES = 5 * 1024 * 1024;

@Processor(QueueName.HISTORY_DIFF_QUEUE, {
  concurrency: 1,
  lockDuration: 120_000,
  stalledInterval: 120_000,
  maxStalledCount: 2,
})
export class HistoryDiffProcessor
  extends WorkerHost
  implements OnModuleDestroy
{
  private readonly logger = new Logger(HistoryDiffProcessor.name);
  private readonly diffPool = new DiffWorkerPool();

  constructor(private readonly pageHistoryRepo: PageHistoryRepo) {
    super();
  }

  async process(job: Job<IPageHistoryDiffJob, void>): Promise<void> {
    if (job.name !== QueueJob.PAGE_HISTORY_DIFF) return;

    const { fromHistoryId, toHistoryId, algorithmVersion } = job.data;
    const existing = await this.pageHistoryRepo.findDiffByTargetHistoryId(
      toHistoryId,
      algorithmVersion,
      HISTORY_DIFF_SCHEMA_VERSION,
    );
    if (existing?.status === 'ready') return;

    try {
      const [fromHistory, toHistory] = await Promise.all([
        this.pageHistoryRepo.findById(fromHistoryId, { includeContent: true }),
        this.pageHistoryRepo.findById(toHistoryId, { includeContent: true }),
      ]);

      if (!fromHistory || !toHistory) {
        throw new Error('history_not_found');
      }
      if (fromHistory.pageId !== toHistory.pageId) {
        throw new Error('history_page_mismatch');
      }
      if (!fromHistory.content || !toHistory.content) {
        throw new Error('history_content_missing');
      }

      await this.pageHistoryRepo.updateDiffStatus(
        toHistoryId,
        algorithmVersion,
        'running',
      );

      const fromJson = JSON.stringify(fromHistory.content);
      const toJson = JSON.stringify(toHistory.content);
      if (
        Buffer.byteLength(fromJson) > MAX_HISTORY_DIFF_CONTENT_BYTES ||
        Buffer.byteLength(toJson) > MAX_HISTORY_DIFF_CONTENT_BYTES
      ) {
        await this.pageHistoryRepo.updateDiffStatus(
          toHistoryId,
          algorithmVersion,
          'too_large',
          'content_too_large',
        );
        return;
      }

      const result = await this.diffPool.runDiff(
        fromHistory.content,
        toHistory.content,
      );
      const changesJson = JSON.stringify(result.changes);
      if (Buffer.byteLength(changesJson) > MAX_HISTORY_DIFF_RESULT_BYTES) {
        await this.pageHistoryRepo.updateDiffStatus(
          toHistoryId,
          algorithmVersion,
          'too_large',
          'result_too_large',
        );
        return;
      }

      await this.pageHistoryRepo.completeDiff(toHistoryId, algorithmVersion, {
        changes: result.changes as unknown as JsonValue,
        addedCount: result.addedCount,
        deletedCount: result.deletedCount,
        fromContentHash: this.hash(fromJson),
        toContentHash: this.hash(toJson),
      });
    } catch (error) {
      const errorCode =
        error instanceof Error ? error.message.slice(0, 200) : 'unknown_error';
      await this.pageHistoryRepo.updateDiffStatus(
        toHistoryId,
        algorithmVersion,
        'failed',
        errorCode,
      );
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job) {
    this.logger.error(
      `Failed history diff for ${job.data.toHistoryId}: ${job.failedReason}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.diffPool.destroy();
    if (this.worker) {
      await this.worker.close();
    }
  }

  private hash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}
