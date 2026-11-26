import { Kysely, sql } from 'kysely';

const constraintName = 'spaces_workspace_personal_owner_unique';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE spaces DROP CONSTRAINT IF EXISTS ${sql.raw(constraintName)}`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE spaces
    ADD CONSTRAINT ${sql.raw(constraintName)} UNIQUE (workspace_id, personal_owner_id)
  `.execute(db);
}
