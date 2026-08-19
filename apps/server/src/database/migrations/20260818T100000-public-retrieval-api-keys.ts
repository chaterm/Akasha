import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('api_keys')
    .addColumn('key_type', 'varchar', (col) =>
      col.notNull().defaultTo('personal'),
    )
    .execute();

  await sql`
    ALTER TABLE api_keys
    ADD CONSTRAINT api_keys_key_type_check
    CHECK (key_type IN ('personal', 'public_retrieval'))
  `.execute(db);

  await db.schema
    .createTable('api_key_spaces')
    .addColumn('api_key_id', 'uuid', (col) =>
      col.notNull().references('api_keys.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('api_key_spaces_pkey', ['api_key_id', 'space_id'])
    .execute();

  await db.schema
    .createIndex('idx_api_key_spaces_space_id')
    .on('api_key_spaces')
    .column('space_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('api_key_spaces').execute();
  await db.schema
    .alterTable('api_keys')
    .dropConstraint('api_keys_key_type_check')
    .execute();
  await db.schema.alterTable('api_keys').dropColumn('key_type').execute();
}
