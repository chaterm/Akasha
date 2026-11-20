import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    UPDATE space_members sm
    SET role = 'reader'
    FROM users u
    WHERE u.id = sm.user_id
      AND u.user_type = 'agent'
      AND sm.role <> 'reader'
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    UPDATE space_members sm
    SET role = 'writer'
    FROM users u
    WHERE u.id = sm.user_id
      AND u.user_type = 'agent'
      AND sm.role = 'reader'
  `.execute(db);
}
