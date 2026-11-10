import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { KnowledgeRunRetentionService } from './knowledge-run-retention.service';

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MAX_BATCHES_PER_SCHEDULE = 20;
// Soft budget: checked before starting a batch. The database statement timeout
// remains the hard bound for an individual batch already in progress.
const SCHEDULE_TIME_BUDGET_MS = 30_000;
// Stale-artifact purge has its own budget so a slow cascade never starves run
// history retention (and vice versa). 20 x 200 pages clears ~4k pages a day.
const MAX_STALE_ARTIFACT_BATCHES_PER_SCHEDULE = 20;
const STALE_ARTIFACT_TIME_BUDGET_MS = 60_000;
// Failed batches are skipped individually; this many in a row means the
// database is unhealthy and the rest of the day's purge is abandoned.
const MAX_CONSECUTIVE_STALE_ARTIFACT_FAILURES = 3;
const STALE_ARTIFACT_LOCKED_BACKOFF_MS = 1_000;

@Injectable()
export class KnowledgeRunRetentionScheduler {
  private readonly logger = new Logger(KnowledgeRunRetentionScheduler.name);
  private running = false;

  constructor(private readonly retention: KnowledgeRunRetentionService) {}

  @Interval('knowledge-run-retention', RETENTION_INTERVAL_MS)
  async purgeExpiredRunHistory(): Promise<void> {
    if (this.running) return;

    this.running = true;
    try {
      await this.purgeRunHistory();
      await this.purgeStaleArtifacts();
    } finally {
      this.running = false;
    }
  }

  private async purgeRunHistory(): Promise<void> {
    const startedAt = Date.now();
    try {
      for (let batch = 0; batch < MAX_BATCHES_PER_SCHEDULE; batch += 1) {
        if (Date.now() - startedAt >= SCHEDULE_TIME_BUDGET_MS) break;
        const result = await this.retention.purgeExpiredRunHistoryBatch();
        if (
          result.deletedImages + result.deletedPages + result.deletedRuns ===
          0
        ) {
          break;
        }
      }
    } catch {
      // A later daily schedule retries. Retention must not affect online work.
    }
  }

  private async purgeStaleArtifacts(): Promise<void> {
    const startedAt = Date.now();
    const totals = {
      deletedKnowledgePages: 0,
      danglingLinks: 0,
      failedBatches: 0,
    };
    let consecutiveFailures = 0;
    for (
      let batch = 0;
      batch < MAX_STALE_ARTIFACT_BATCHES_PER_SCHEDULE;
      batch += 1
    ) {
      if (Date.now() - startedAt >= STALE_ARTIFACT_TIME_BUDGET_MS) break;
      try {
        const result = await this.retention.purgeStaleArtifactsBatch();
        consecutiveFailures = 0;
        totals.deletedKnowledgePages += result.deletedKnowledgePages;
        totals.danglingLinks += result.danglingLinks;
        if (result.deletedKnowledgePages > 0) continue;
        // Empty claim: stop only when the backlog is really empty. If another
        // instance holds the remaining rows, back off and try again so a
        // rollback on its side (e.g. deadlock) does not strand the backlog.
        if (!result.remainingLocked) break;
        await this.delay(STALE_ARTIFACT_LOCKED_BACKOFF_MS);
      } catch (error) {
        // A single batch can be aborted (deadlock with a concurrent publish,
        // statement timeout). Skip it and keep going; only a run of failures
        // suggests an outage worth giving up on until tomorrow.
        totals.failedBatches += 1;
        consecutiveFailures += 1;
        this.logger.warn(
          `Stale knowledge artifact purge batch failed (${consecutiveFailures} in a row): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_STALE_ARTIFACT_FAILURES) {
          break;
        }
      }
    }
    if (totals.deletedKnowledgePages > 0 || totals.failedBatches > 0) {
      this.logger.log(
        `Purged stale knowledge artifacts: ${JSON.stringify({
          ...totals,
          durationMs: Date.now() - startedAt,
        })}`,
      );
    }
  }

  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
