import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE knowledge_space_compile_run_images
      DROP CONSTRAINT IF EXISTS chk_knowledge_space_compile_run_images_ordinal
  `.execute(db);
  await sql`
    ALTER TABLE knowledge_space_compile_run_images
      ADD CONSTRAINT chk_knowledge_space_compile_run_images_ordinal
      CHECK (image_ordinal BETWEEN 0 AND 149)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE knowledge_space_compile_run_images
      DROP CONSTRAINT IF EXISTS chk_knowledge_space_compile_run_images_ordinal
  `.execute(db);
  await sql`
    ALTER TABLE knowledge_space_compile_run_images
      ADD CONSTRAINT chk_knowledge_space_compile_run_images_ordinal
      CHECK (image_ordinal BETWEEN 0 AND 49)
  `.execute(db);
}
