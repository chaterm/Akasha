import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('ai_model_configs')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    // One row per configurable feature. Global (instance-wide) configuration,
    // so there is deliberately no workspace_id column.
    .addColumn('feature', 'varchar', (col) =>
      col
        .notNull()
        .unique()
        .check(sql`feature in ('compiler', 'answer', 'image', 'embedding')`),
    )
    .addColumn('provider', 'varchar', (col) =>
      col.notNull().check(sql`provider in ('openai-compatible')`),
    )
    .addColumn('model', 'varchar', (col) => col.notNull())
    .addColumn('base_url', 'varchar', (col) => col)
    // AES-256-GCM ciphertext (iv:authTag:data hex), encrypted with APP_SECRET.
    .addColumn('api_key_encrypted', 'text', (col) => col)
    // Feature-specific tuning (embedding dimensions, MRL support…).
    .addColumn('parameters', 'jsonb', (col) => col)
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ai_model_configs').execute();
}
