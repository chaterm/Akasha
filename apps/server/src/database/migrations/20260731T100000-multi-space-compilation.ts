import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_space_compile_runs')
    .addColumn('initialized_at', 'timestamptz')
    .addColumn('space_job_id', 'varchar')
    .addColumn('space_job_dispatched_at', 'timestamptz')
    .addColumn('space_job_sequence', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('space_job_queued_at', 'timestamptz')
    .addColumn('space_job_recovery_count', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('execution_token', 'varchar')
    .addColumn('execution_lease_expires_at', 'timestamptz')
    .addColumn('worker_id', 'varchar')
    .addColumn('heartbeat_at', 'timestamptz')
    .addColumn('last_yield_at', 'timestamptz')
    .addColumn('last_yield_reason', 'varchar')
    .addColumn('rerun_requested', 'boolean', (col) =>
      col.notNull().defaultTo(false),
    )
    .execute();

  await sql`
    ALTER TABLE knowledge_space_compile_runs
      DROP CONSTRAINT chk_knowledge_space_compile_runs_phase,
      ADD CONSTRAINT chk_knowledge_space_compile_runs_phase
      CHECK (phase IN (
        'text', 'initial_aggregate', 'images', 'image_merge',
        'final_aggregate', 'complete'
      )),
      ADD CONSTRAINT chk_knowledge_space_compile_runs_space_job_sequence
      CHECK (space_job_sequence >= 0),
      ADD CONSTRAINT chk_knowledge_space_compile_runs_space_job_recovery_count
      CHECK (space_job_recovery_count BETWEEN 0 AND 3),
      ADD CONSTRAINT chk_knowledge_space_compile_runs_last_yield_reason
      CHECK (
        last_yield_reason IS NULL OR
        last_yield_reason IN ('page_limit', 'time_limit')
      )
  `.execute(db);

  await db.schema
    .createIndex('idx_knowledge_space_compile_runs_space_dispatch')
    .on('knowledge_space_compile_runs')
    .columns(['status', 'phase', 'space_job_queued_at'])
    .execute();
  await db.schema
    .createIndex('idx_knowledge_space_compile_runs_workspace_status_phase')
    .on('knowledge_space_compile_runs')
    .columns(['workspace_id', 'status', 'phase', 'updated_at'])
    .execute();

  await db.schema
    .createTable('knowledge_space_compile_run_images')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('run_id', 'uuid', (col) =>
      col
        .notNull()
        .references('knowledge_space_compile_runs.id')
        .onDelete('cascade'),
    )
    .addColumn('run_page_id', 'uuid', (col) =>
      col
        .notNull()
        .references('knowledge_space_compile_run_pages.id')
        .onDelete('cascade'),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    // Page and attachment rows may be deleted while a frozen run is active.
    // Keep their identities without FKs so the image barrier can terminalize.
    .addColumn('source_page_id', 'uuid', (col) => col.notNull())
    .addColumn('attachment_id', 'uuid', (col) => col.notNull())
    .addColumn('image_ordinal', 'integer', (col) => col.notNull())
    .addColumn('file_name', 'varchar', (col) => col.notNull())
    .addColumn('mime_type', 'varchar', (col) => col.notNull())
    .addColumn('file_size', 'bigint')
    .addColumn('alt_text', 'text')
    .addColumn('expected_attachment_version', 'timestamptz', (col) =>
      col.notNull(),
    )
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('pending'))
    .addColumn('job_id', 'varchar')
    .addColumn('dispatched_at', 'timestamptz')
    .addColumn('processing_expires_at', 'timestamptz')
    .addColumn('extraction_id', 'uuid', (col) =>
      col.references('knowledge_image_extractions.id').onDelete('set null'),
    )
    .addColumn('attempt_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('redis_recovery_count', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('failure_class', 'varchar')
    .addColumn('error_code', 'varchar')
    .addColumn('error_message', 'varchar')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await sql`
    ALTER TABLE knowledge_space_compile_run_images
      ADD CONSTRAINT chk_knowledge_space_compile_run_images_status
      CHECK (status IN (
        'pending', 'queued', 'processing', 'succeeded', 'failed', 'skipped'
      )),
      ADD CONSTRAINT chk_knowledge_space_compile_run_images_attempt_count
      CHECK (attempt_count >= 0),
      ADD CONSTRAINT chk_knowledge_space_compile_run_images_recovery_count
      CHECK (redis_recovery_count BETWEEN 0 AND 3),
      ADD CONSTRAINT chk_knowledge_space_compile_run_images_failure_class
      CHECK (
        failure_class IS NULL OR
        failure_class IN ('retryable_exhausted', 'permanent')
      ),
      ADD CONSTRAINT chk_knowledge_space_compile_run_images_failure_lifecycle
      CHECK (
        (status = 'failed' OR failure_class IS NULL) AND
        (status != 'failed' OR failure_class IS NOT NULL)
      ),
      ADD CONSTRAINT chk_knowledge_space_compile_run_images_ordinal
      CHECK (image_ordinal BETWEEN 0 AND 49),
      ADD CONSTRAINT chk_knowledge_space_compile_run_images_file_size
      CHECK (file_size IS NULL OR file_size >= 0),
      ADD CONSTRAINT chk_knowledge_space_compile_run_images_mime_type
      CHECK (mime_type IN (
        'image/jpeg', 'image/png', 'image/apng', 'image/gif', 'image/webp',
        'image/avif', 'image/tiff', 'image/bmp'
      ))
  `.execute(db);

  await db.schema
    .createIndex('uq_knowledge_space_compile_run_images_run_source_attachment')
    .unique()
    .on('knowledge_space_compile_run_images')
    .columns(['run_id', 'source_page_id', 'attachment_id'])
    .execute();
  await db.schema
    .createIndex('uq_knowledge_space_compile_run_images_page_ordinal')
    .unique()
    .on('knowledge_space_compile_run_images')
    .columns(['run_page_id', 'image_ordinal'])
    .execute();
  await sql`
    CREATE UNIQUE INDEX uq_knowledge_space_compile_run_images_job_id
      ON knowledge_space_compile_run_images (job_id)
      WHERE job_id IS NOT NULL
  `.execute(db);
  await db.schema
    .createIndex('idx_knowledge_space_compile_run_images_run_status')
    .on('knowledge_space_compile_run_images')
    .columns(['run_id', 'status', 'created_at'])
    .execute();
  await db.schema
    .createIndex('idx_knowledge_space_compile_run_images_reaper')
    .on('knowledge_space_compile_run_images')
    .columns(['status', 'dispatched_at', 'updated_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropTable('knowledge_space_compile_run_images')
    .ifExists()
    .execute();

  await db.schema
    .dropIndex('idx_knowledge_space_compile_runs_workspace_status_phase')
    .ifExists()
    .execute();
  await db.schema
    .dropIndex('idx_knowledge_space_compile_runs_space_dispatch')
    .ifExists()
    .execute();

  await sql`
    UPDATE knowledge_space_compile_runs
    SET phase = 'images'
    WHERE phase = 'image_merge'
  `.execute(db);
  await sql`
    ALTER TABLE knowledge_space_compile_runs
      DROP CONSTRAINT IF EXISTS
        chk_knowledge_space_compile_runs_last_yield_reason,
      DROP CONSTRAINT IF EXISTS
        chk_knowledge_space_compile_runs_space_job_recovery_count,
      DROP CONSTRAINT IF EXISTS
        chk_knowledge_space_compile_runs_space_job_sequence,
      DROP CONSTRAINT IF EXISTS chk_knowledge_space_compile_runs_phase,
      ADD CONSTRAINT chk_knowledge_space_compile_runs_phase
      CHECK (phase IN (
        'text', 'initial_aggregate', 'images', 'final_aggregate', 'complete'
      ))
  `.execute(db);

  await db.schema
    .alterTable('knowledge_space_compile_runs')
    .dropColumn('rerun_requested')
    .dropColumn('last_yield_reason')
    .dropColumn('last_yield_at')
    .dropColumn('heartbeat_at')
    .dropColumn('worker_id')
    .dropColumn('execution_lease_expires_at')
    .dropColumn('execution_token')
    .dropColumn('space_job_recovery_count')
    .dropColumn('space_job_queued_at')
    .dropColumn('space_job_sequence')
    .dropColumn('space_job_dispatched_at')
    .dropColumn('space_job_id')
    .dropColumn('initialized_at')
    .execute();
}
