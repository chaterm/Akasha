import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table pages
      add column if not exists source_creator_name varchar,
      add column if not exists source_last_updated_by_name varchar
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    alter table pages
      drop column if exists source_last_updated_by_name,
      drop column if exists source_creator_name
  `.execute(db);
}
