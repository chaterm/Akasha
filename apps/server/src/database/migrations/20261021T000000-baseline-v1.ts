import { type Kysely, sql } from 'kysely';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function up(db: Kysely<any>): Promise<void> {
  const schema = await readFile(
    join(__dirname, '20261021T000000-baseline-v1.sql'),
    'utf8',
  );
  await sql.raw(schema).execute(db);
}

export async function down(_db: Kysely<any>): Promise<void> {}
