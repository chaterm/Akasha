import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE knowledge_space_compile_runs
      DROP CONSTRAINT chk_knowledge_space_compile_runs_status,
      ADD CONSTRAINT chk_knowledge_space_compile_runs_status
      CHECK (status IN (
        'queued', 'compiling', 'aggregate_pending', 'aggregating',
        'succeeded', 'partial', 'failed', 'superseded', 'cancelled'
      ))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE knowledge_space_compile_runs
    SET
      status = 'superseded',
      error_code = 'run_superseded',
      error_message = 'Knowledge compilation run was cancelled.',
      updated_at = now()
    WHERE status = 'cancelled'
  `.execute(db);
  await sql`
    ALTER TABLE knowledge_space_compile_runs
      DROP CONSTRAINT chk_knowledge_space_compile_runs_status,
      ADD CONSTRAINT chk_knowledge_space_compile_runs_status
      CHECK (status IN (
        'queued', 'compiling', 'aggregate_pending', 'aggregating',
        'succeeded', 'partial', 'failed', 'superseded'
      ))
  `.execute(db);
}
