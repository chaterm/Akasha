import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Older deployments allowed more than one active run per space. Preserve the
  // newest run and terminalize every older duplicate before adding the guard.
  await sql
    .raw(
      `
    WITH ranked_active_runs AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY workspace_id, space_id ORDER BY created_at DESC, id DESC
        ) AS active_rank
      FROM knowledge_space_compile_runs
      WHERE status IN ('queued', 'compiling', 'aggregate_pending', 'aggregating')
    ), duplicate_active_runs AS (
      SELECT id
      FROM ranked_active_runs
      WHERE active_rank > 1
    )
    UPDATE knowledge_space_compile_run_pages AS pages
    SET
      status = 'skipped',
      error_code = 'run_superseded',
      error_message = 'Knowledge compilation run was superseded.',
      finished_at = COALESCE(pages.finished_at, now()),
      updated_at = now()
    FROM duplicate_active_runs AS duplicate
    WHERE pages.run_id = duplicate.id
      AND pages.status IN ('pending', 'queued', 'running')
  `,
    )
    .execute(db);

  await sql
    .raw(
      `
    WITH ranked_active_runs AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY workspace_id, space_id ORDER BY created_at DESC, id DESC
        ) AS active_rank
      FROM knowledge_space_compile_runs
      WHERE status IN ('queued', 'compiling', 'aggregate_pending', 'aggregating')
    ), duplicate_active_runs AS (
      SELECT id
      FROM ranked_active_runs
      WHERE active_rank > 1
    )
    UPDATE knowledge_space_compile_runs AS runs
    SET
      status = 'superseded',
      skipped_page_count = (
        SELECT COUNT(*)::int
        FROM knowledge_space_compile_run_pages AS pages
        WHERE pages.run_id = runs.id AND pages.status = 'skipped'
      ),
      error_code = 'run_superseded',
      error_message = 'A newer knowledge compilation run replaced this run.',
      finished_at = COALESCE(runs.finished_at, now()),
      updated_at = now()
    FROM duplicate_active_runs AS duplicate
    WHERE runs.id = duplicate.id
  `,
    )
    .execute(db);

  await sql
    .raw(
      `
    CREATE UNIQUE INDEX uq_knowledge_space_compile_runs_active_space
      ON knowledge_space_compile_runs (workspace_id, space_id)
      WHERE status IN ('queued', 'compiling', 'aggregate_pending', 'aggregating')
  `,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS uq_knowledge_space_compile_runs_active_space
  `.execute(db);
}
