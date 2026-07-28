import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('spaces')
    .addColumn('knowledge_generation', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .execute();

  await db.schema
    .alterTable('knowledge_space_compile_runs')
    .addColumn('mode', 'varchar', (col) =>
      col.notNull().defaultTo('incremental'),
    )
    .addColumn('knowledge_generation', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('phase', 'varchar', (col) => col.notNull().defaultTo('text'))
    .execute();

  await db.schema
    .alterTable('knowledge_space_compile_run_pages')
    .addColumn('expected_image_count', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('succeeded_image_count', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('failed_image_count', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('image_status', 'varchar', (col) =>
      col.notNull().defaultTo('not_required'),
    )
    .addColumn('image_job_id', 'varchar')
    .addColumn('merge_status', 'varchar', (col) =>
      col.notNull().defaultTo('not_required'),
    )
    .addColumn('merge_job_id', 'varchar')
    .addColumn('target_effective_knowledge_hash', 'varchar')
    .addColumn('merged_effective_knowledge_hash', 'varchar')
    .execute();

  await db.schema
    .alterTable('knowledge_compilation_attempts')
    .addColumn('effective_knowledge_hash', 'varchar')
    .addColumn('last_successful_effective_hash', 'varchar')
    .execute();

  await sql`
    ALTER TABLE spaces
      ADD CONSTRAINT chk_spaces_knowledge_generation
      CHECK (knowledge_generation >= 0)
  `.execute(db);
  await sql`
    ALTER TABLE knowledge_space_compile_runs
      ADD CONSTRAINT chk_knowledge_space_compile_runs_mode
      CHECK (mode IN ('incremental', 'force_rebuild')),
      ADD CONSTRAINT chk_knowledge_space_compile_runs_knowledge_generation
      CHECK (knowledge_generation >= 0),
      ADD CONSTRAINT chk_knowledge_space_compile_runs_phase
      CHECK (phase IN (
        'text', 'initial_aggregate', 'images', 'final_aggregate', 'complete'
      ))
  `.execute(db);
  await sql`
    ALTER TABLE knowledge_space_compile_run_pages
      ADD CONSTRAINT chk_knowledge_space_compile_run_pages_image_counts
      CHECK (
        expected_image_count >= 0 AND
        succeeded_image_count >= 0 AND
        failed_image_count >= 0 AND
        succeeded_image_count + failed_image_count <= expected_image_count
      ),
      ADD CONSTRAINT chk_knowledge_space_compile_run_pages_image_status
      CHECK (image_status IN (
        'not_required', 'pending', 'queued', 'processing',
        'succeeded', 'partial', 'failed'
      )),
      ADD CONSTRAINT chk_knowledge_space_compile_run_pages_merge_status
      CHECK (merge_status IN (
        'not_required', 'waiting_images', 'pending', 'queued', 'running',
        'succeeded', 'skipped', 'failed'
      ))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE knowledge_space_compile_run_pages
      DROP CONSTRAINT IF EXISTS
        chk_knowledge_space_compile_run_pages_merge_status,
      DROP CONSTRAINT IF EXISTS
        chk_knowledge_space_compile_run_pages_image_status,
      DROP CONSTRAINT IF EXISTS
        chk_knowledge_space_compile_run_pages_image_counts
  `.execute(db);
  await sql`
    ALTER TABLE knowledge_space_compile_runs
      DROP CONSTRAINT IF EXISTS chk_knowledge_space_compile_runs_phase,
      DROP CONSTRAINT IF EXISTS
        chk_knowledge_space_compile_runs_knowledge_generation,
      DROP CONSTRAINT IF EXISTS chk_knowledge_space_compile_runs_mode
  `.execute(db);
  await sql`
    ALTER TABLE spaces
      DROP CONSTRAINT IF EXISTS chk_spaces_knowledge_generation
  `.execute(db);

  await db.schema
    .alterTable('knowledge_compilation_attempts')
    .dropColumn('last_successful_effective_hash')
    .dropColumn('effective_knowledge_hash')
    .execute();
  await db.schema
    .alterTable('knowledge_space_compile_run_pages')
    .dropColumn('merged_effective_knowledge_hash')
    .dropColumn('target_effective_knowledge_hash')
    .dropColumn('merge_job_id')
    .dropColumn('merge_status')
    .dropColumn('image_job_id')
    .dropColumn('image_status')
    .dropColumn('failed_image_count')
    .dropColumn('succeeded_image_count')
    .dropColumn('expected_image_count')
    .execute();
  await db.schema
    .alterTable('knowledge_space_compile_runs')
    .dropColumn('phase')
    .dropColumn('knowledge_generation')
    .dropColumn('mode')
    .execute();
  await db.schema
    .alterTable('spaces')
    .dropColumn('knowledge_generation')
    .execute();
}
