import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_compilation_attempts')
    .addColumn('compiler_model', 'varchar')
    .addColumn('compiler_profile', 'varchar')
    .addColumn('result_quality', 'varchar', (col) =>
      col.notNull().defaultTo('normal'),
    )
    .addColumn('analysis_candidate_ids', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn('analysis_candidate_hash', 'varchar')
    .addColumn('generation_candidate_ids', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn('generation_candidate_hash', 'varchar')
    .addColumn('generation_attempt_source_hash', 'varchar')
    .addColumn('generation_attempt_count', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .execute();

  await sql`
    ALTER TABLE knowledge_compilation_attempts
      ADD CONSTRAINT chk_knowledge_compilation_attempts_result_quality
        CHECK (result_quality IN ('normal', 'degraded', 'partial_image')),
      ADD CONSTRAINT chk_knowledge_compilation_attempts_generation_count
        CHECK (generation_attempt_count BETWEEN 0 AND 3)
  `.execute(db);

  // Keep the two aggregate values readable for legacy rows, while new Runs
  // use finalizing as the bounded, non-LLM convergence phase.
  await sql`
    ALTER TABLE knowledge_space_compile_runs
      DROP CONSTRAINT IF EXISTS chk_knowledge_space_compile_runs_phase,
      ADD CONSTRAINT chk_knowledge_space_compile_runs_phase
        CHECK (phase IN (
          'text', 'initial_aggregate', 'images', 'image_merge',
          'final_aggregate', 'finalizing', 'complete'
        ))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE knowledge_space_compile_runs
      DROP CONSTRAINT IF EXISTS chk_knowledge_space_compile_runs_phase,
      ADD CONSTRAINT chk_knowledge_space_compile_runs_phase
        CHECK (phase IN (
          'text', 'initial_aggregate', 'images', 'image_merge',
          'final_aggregate', 'complete'
        ))
  `.execute(db);
  await sql`
    ALTER TABLE knowledge_compilation_attempts
      DROP CONSTRAINT IF EXISTS
        chk_knowledge_compilation_attempts_generation_count,
      DROP CONSTRAINT IF EXISTS
        chk_knowledge_compilation_attempts_result_quality
  `.execute(db);
  await db.schema
    .alterTable('knowledge_compilation_attempts')
    .dropColumn('generation_attempt_count')
    .dropColumn('generation_attempt_source_hash')
    .dropColumn('generation_candidate_hash')
    .dropColumn('generation_candidate_ids')
    .dropColumn('analysis_candidate_hash')
    .dropColumn('analysis_candidate_ids')
    .dropColumn('result_quality')
    .dropColumn('compiler_profile')
    .dropColumn('compiler_model')
    .execute();
}
