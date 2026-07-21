import { type Kysely } from 'kysely';

// Configure via environment variables before running migrations:
//   HOIDC_SSO_API       - SSO API base URL (e.g. https://webapi-sso.example.com)
//   HOIDC_PLATFORM_ID   - platform_id credential issued by SSO provider
export async function up(db: Kysely<any>): Promise<void> {
  const ssoApi = process.env.HOIDC_SSO_API;
  const platformId = process.env.HOIDC_PLATFORM_ID;

  if (!ssoApi || !platformId) {
    console.warn(
      'Skipping HOIDC seed: HOIDC_SSO_API and HOIDC_PLATFORM_ID must both be set.',
    );
    return;
  }

  const workspace = await db
    .selectFrom('workspaces')
    .select('id')
    .orderBy('created_at', 'asc')
    .limit(1)
    .executeTakeFirst();
  if (!workspace) {
    console.warn('Skipping HOIDC seed: workspace is not initialized.');
    return;
  }

  await db
    .insertInto('auth_providers')
    .values({
      name: 'HOIDC',
      type: 'hoidc',
      oidc_issuer: ssoApi,
      oidc_client_id: platformId,
      is_enabled: true,
      allow_signup: true,
      workspace_id: workspace.id,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  const workspace = await db
    .selectFrom('workspaces')
    .select('id')
    .orderBy('created_at', 'asc')
    .limit(1)
    .executeTakeFirst();
  if (!workspace) return;

  await db
    .deleteFrom('auth_providers')
    .where('workspace_id', '=', workspace.id)
    .where('type', '=', 'hoidc')
    .execute();
}
