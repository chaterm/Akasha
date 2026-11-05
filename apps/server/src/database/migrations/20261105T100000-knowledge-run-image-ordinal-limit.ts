import { Kysely, sql } from 'kysely';

/**
 * RunImage ordinal ceiling now follows MAX_KNOWLEDGE_IMAGES_PER_PAGE (150).
 *
 * The Text phase binds every planned image of a page in one statement and uses
 * the plan index as image_ordinal, so the CHECK must cover the same range the
 * compiler is allowed to plan. The previous 0..49 bound silently aborted the
 * whole bind transaction once a page carried 50+ images.
 */
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
