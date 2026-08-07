import { Kysely, sql } from 'kysely';

/**
 * Source contributions are the durable input for precise artifact retirement.
 * They must outlive a hard-deleted page until the retirement worker has
 * atomically re-materialized survivors and removed the retired contribution.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE knowledge_artifact_contributions
      DROP CONSTRAINT IF EXISTS
        knowledge_artifact_contributions_source_page_id_fkey
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Do not fabricate or silently discard contribution history on rollback.
  // A normal rollback is possible after retirement has removed all dangling
  // rows; otherwise the operator must let retirement converge first.
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM knowledge_artifact_contributions contribution
        LEFT JOIN pages page ON page.id = contribution.source_page_id
        WHERE page.id IS NULL
      ) THEN
        RAISE EXCEPTION
          'Cannot restore contribution cascade FK while retired source rows remain';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'knowledge_artifact_contributions'::regclass
          AND conname =
            'knowledge_artifact_contributions_source_page_id_fkey'
      ) THEN
        ALTER TABLE knowledge_artifact_contributions
          ADD CONSTRAINT
            knowledge_artifact_contributions_source_page_id_fkey
          FOREIGN KEY (source_page_id)
          REFERENCES pages(id)
          ON DELETE CASCADE;
      END IF;
    END
    $$
  `.execute(db);
}
