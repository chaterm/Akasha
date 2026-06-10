import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // The `auth_providers.type` column may be either the legacy `auth_provider_type`
  // enum or a plain `text` column (the ldap migration converts the enum to text and
  // drops the type). Only add the enum value when the enum type still exists; when the
  // column is text, no schema change is needed to allow the 'hoidc' value.
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_type WHERE typname = 'auth_provider_type'
    ) AS exists
  `.execute(db);

  if (result.rows[0]?.exists) {
    await sql`
      ALTER TYPE auth_provider_type ADD VALUE IF NOT EXISTS 'hoidc'
    `.execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('auth_providers')
    .alterColumn('type', (col) => col.setDataType('text'))
    .execute();

  await sql`
    CREATE TYPE auth_provider_type_tmp AS ENUM ('saml', 'oidc', 'google')
  `.execute(db);

  await sql`
    ALTER TABLE auth_providers
    ALTER COLUMN type TYPE auth_provider_type_tmp
    USING CASE
      WHEN type = 'hoidc' THEN 'oidc'::text::auth_provider_type_tmp
      ELSE type::text::auth_provider_type_tmp
    END
  `.execute(db);

  await sql`DROP TYPE auth_provider_type`.execute(db);
  await sql`ALTER TYPE auth_provider_type_tmp RENAME TO auth_provider_type`.execute(
    db,
  );
}
