import { Kysely, sql } from 'kysely';

/**
 * Night compile window.
 * - Page restores from the trash queue through the delayed schedule table
 *   with their own trigger, so the schedule CHECK accepts page_restored.
 * - Space-level admin compilation requested outside the window is stored as
 *   one durable intent per Space and promoted into a normal Run once the
 *   window opens. Intents never enter knowledge_space_compile_runs, so the
 *   single-active-Run invariant is untouched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE knowledge_page_compile_schedules
      DROP CONSTRAINT IF EXISTS chk_knowledge_page_compile_schedules_trigger
  `.execute(db);
  await sql`
    ALTER TABLE knowledge_page_compile_schedules
      ADD CONSTRAINT chk_knowledge_page_compile_schedules_trigger
      CHECK (trigger IN ('page_created', 'page_updated', 'page_restored'))
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS knowledge_space_deferred_compiles (
      id uuid DEFAULT gen_uuid_v7() NOT NULL PRIMARY KEY,
      workspace_id uuid NOT NULL,
      space_id uuid NOT NULL,
      scan_removed_sources boolean NOT NULL DEFAULT false,
      request_count integer NOT NULL DEFAULT 1,
      requested_by uuid,
      first_requested_at timestamptz NOT NULL,
      last_requested_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_knowledge_space_deferred_compiles_space
        UNIQUE (workspace_id, space_id),
      CONSTRAINT chk_knowledge_space_deferred_compiles_request_count
        CHECK (request_count >= 1),
      CONSTRAINT chk_knowledge_space_deferred_compiles_time_order
        CHECK (first_requested_at <= last_requested_at)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS knowledge_space_deferred_compiles`.execute(db);
  // Restored-page rows would violate the original CHECK; they are plain
  // pending compiles, so dropping them only loses a not-yet-run restore pass.
  await sql`
    DELETE FROM knowledge_page_compile_schedules
    WHERE trigger = 'page_restored'
  `.execute(db);
  await sql`
    ALTER TABLE knowledge_page_compile_schedules
      DROP CONSTRAINT IF EXISTS chk_knowledge_page_compile_schedules_trigger
  `.execute(db);
  await sql`
    ALTER TABLE knowledge_page_compile_schedules
      ADD CONSTRAINT chk_knowledge_page_compile_schedules_trigger
      CHECK (trigger IN ('page_created', 'page_updated'))
  `.execute(db);
}
