import { Kysely, sql } from 'kysely';

const constraintName = 'spaces_workspace_personal_owner_unique';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('spaces')
    .addColumn('is_default_personal', 'boolean', (column) =>
      column.notNull().defaultTo(false),
    )
    .execute();

  await sql`
    UPDATE spaces
    SET is_default_personal = true
    WHERE personal_owner_id IS NOT NULL AND deleted_at IS NULL
  `.execute(db);

  await sql`ALTER TABLE spaces DROP CONSTRAINT IF EXISTS ${sql.id(constraintName)}`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE spaces
    ADD CONSTRAINT ${sql.id(constraintName)} UNIQUE (workspace_id, personal_owner_id)
  `.execute(db);
  await db.schema
    .alterTable('spaces')
    .dropColumn('is_default_personal')
    .execute();
}
