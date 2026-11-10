import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { executeTx } from '@akasha/db/utils';

const RUN_RETENTION_DAYS = 30;
const RUN_IMAGE_BATCH_SIZE = 1_000;
const RUN_PAGE_BATCH_SIZE = 1_000;
const RUN_BATCH_SIZE = 100;
// Stale KnowledgePages keep their stable id so a later compile can revive them
// in place. After this grace period revival is unlikely and the rows (plus
// their cascaded chunks/sections/links) are only dead weight.
const STALE_ARTIFACT_RETENTION_DAYS = 30;
// Each KnowledgePage cascades to roughly ten child rows; keep transactions short.
const STALE_ARTIFACT_BATCH_SIZE = 200;

export type KnowledgeRunRetentionBatchResult = {
  deletedImages: number;
  deletedPages: number;
  deletedRuns: number;
  durationMs: number;
};

export type KnowledgeStaleArtifactPurgeResult = {
  deletedKnowledgePages: number;
  danglingLinks: number;
  /**
   * True when this batch claimed nothing but eligible pages still exist, i.e.
   * they are locked by a concurrent purger. Callers should not treat the batch
   * as "backlog empty".
   */
  remainingLocked: boolean;
  durationMs: number;
};

@Injectable()
export class KnowledgeRunRetentionService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async purgeExpiredRunHistoryBatch(): Promise<KnowledgeRunRetentionBatchResult> {
    const startedAt = Date.now();
    const cutoff = new Date(
      startedAt - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
    );

    const deletedImages = await executeTx(this.db, async (trx) => {
      const result = await sql<{ id: string }>`
        WITH candidates AS (
          SELECT image.id
          FROM knowledge_space_compile_run_images AS image
          INNER JOIN knowledge_space_compile_runs AS run ON run.id = image.run_id
          INNER JOIN spaces AS space ON space.id = run.space_id
          WHERE ${eligibleRun(cutoff)}
          ORDER BY run.finished_at ASC, image.id ASC
          LIMIT ${RUN_IMAGE_BATCH_SIZE}
          FOR UPDATE OF image SKIP LOCKED
        )
        DELETE FROM knowledge_space_compile_run_images AS image
        USING candidates
        WHERE image.id = candidates.id
        RETURNING image.id
      `.execute(trx);
      return result.rows.length;
    });

    const deletedPages = await executeTx(this.db, async (trx) => {
      const result = await sql<{ id: string }>`
        WITH candidates AS (
          SELECT page.id
          FROM knowledge_space_compile_run_pages AS page
          INNER JOIN knowledge_space_compile_runs AS run ON run.id = page.run_id
          INNER JOIN spaces AS space ON space.id = run.space_id
          WHERE ${eligibleRun(cutoff)}
            AND NOT EXISTS (
              SELECT 1
              FROM knowledge_space_compile_run_images AS image
              WHERE image.run_page_id = page.id
            )
          ORDER BY run.finished_at ASC, page.id ASC
          LIMIT ${RUN_PAGE_BATCH_SIZE}
          FOR UPDATE OF page SKIP LOCKED
        )
        DELETE FROM knowledge_space_compile_run_pages AS page
        USING candidates
        WHERE page.id = candidates.id
        RETURNING page.id
      `.execute(trx);
      return result.rows.length;
    });

    const deletedRuns = await executeTx(this.db, async (trx) => {
      const result = await sql<{ id: string }>`
        WITH candidates AS (
          SELECT run.id
          FROM knowledge_space_compile_runs AS run
          INNER JOIN spaces AS space ON space.id = run.space_id
          WHERE ${eligibleRun(cutoff)}
            AND NOT EXISTS (
              SELECT 1
              FROM knowledge_space_compile_run_pages AS page
              WHERE page.run_id = run.id
            )
          ORDER BY run.finished_at ASC, run.id ASC
          LIMIT ${RUN_BATCH_SIZE}
          FOR UPDATE OF run SKIP LOCKED
        )
        DELETE FROM knowledge_space_compile_runs AS run
        USING candidates
        WHERE run.id = candidates.id
        RETURNING run.id
      `.execute(trx);
      return result.rows.length;
    });

    return {
      deletedImages,
      deletedPages,
      deletedRuns,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Hard-deletes KnowledgePages that have been stale for longer than the grace
   * period. Child rows go through FK cascades. Active inbound links are first
   * turned back into dangling canonical references: otherwise the link FK
   * would null the target while leaving is_dangling=false, so
   * resolveCanonicalReferences could never re-attach them when the concept is
   * regenerated.
   */
  async purgeStaleArtifactsBatch(): Promise<KnowledgeStaleArtifactPurgeResult> {
    const startedAt = Date.now();
    const cutoff = new Date(
      startedAt - STALE_ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
    );

    return executeTx(this.db, async (trx) => {
      const candidates = await sql<{ id: string }>`
        SELECT kp.id
        FROM knowledge_pages AS kp
        WHERE ${eligibleStalePage(cutoff)}
        ORDER BY kp.stale_at ASC, kp.id ASC
        LIMIT ${STALE_ARTIFACT_BATCH_SIZE}
        FOR UPDATE OF kp SKIP LOCKED
      `.execute(trx);
      if (candidates.rows.length === 0) {
        // SKIP LOCKED cannot tell "nothing eligible" from "every eligible row
        // is held by another purger". Check without locking so callers only
        // stop when the backlog is actually empty.
        const remaining = await sql<{ exists: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM knowledge_pages AS kp
            WHERE ${eligibleStalePage(cutoff)}
          ) AS exists
        `.execute(trx);
        return {
          deletedKnowledgePages: 0,
          danglingLinks: 0,
          remainingLocked: remaining.rows[0]?.exists === true,
          durationMs: Date.now() - startedAt,
        };
      }
      const ids = sql.join(candidates.rows.map((row) => sql`${row.id}`));

      // Stale inbound rows are left alone: they are purged with their own
      // stale owner page or rewritten when that page is republished.
      const danglingLinks = await sql<{ id: string }>`
        UPDATE knowledge_links
        SET is_dangling = true, to_knowledge_page_id = NULL
        WHERE to_knowledge_page_id IN (${ids})
          AND stale_at IS NULL
        RETURNING id
      `.execute(trx);

      // Re-check staleness: the rows are locked, but keep the delete predicate
      // self-contained so it can never remove a revived page.
      const deleted = await sql<{ id: string }>`
        DELETE FROM knowledge_pages
        WHERE id IN (${ids})
          AND stale_at IS NOT NULL
          AND stale_at < ${cutoff}
        RETURNING id
      `.execute(trx);

      return {
        deletedKnowledgePages: deleted.rows.length,
        danglingLinks: danglingLinks.rows.length,
        remainingLocked: false,
        durationMs: Date.now() - startedAt,
      };
    });
  }
}

// Spaces with a live Run are skipped: only Runs publish (and therefore revive)
// KnowledgePages, so this avoids racing a concurrent publish.
function eligibleStalePage(cutoff: Date) {
  return sql<boolean>`
    kp.stale_at IS NOT NULL
    AND kp.stale_at < ${cutoff}
    AND NOT EXISTS (
      SELECT 1
      FROM knowledge_space_compile_runs AS run
      WHERE run.workspace_id = kp.workspace_id
        AND run.space_id = kp.space_id
        AND run.status IN ('queued', 'compiling', 'aggregating')
    )
  `;
}

function eligibleRun(cutoff: Date) {
  return sql<boolean>`
    run.finished_at IS NOT NULL
    AND run.finished_at < ${cutoff}
    AND run.status IN ('succeeded', 'partial', 'failed', 'cancelled', 'superseded')
    AND (
      run.knowledge_generation < space.knowledge_generation
      OR run.status IN ('failed', 'cancelled', 'superseded')
    )
  `;
}
