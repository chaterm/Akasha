import { type Kysely } from 'kysely';

// Configure via environment variables before running migrations:
//   HOIDC_WORKSPACE_ID  - target workspace UUID
//   HOIDC_SSO_API       - SSO API base URL (e.g. https://webapi-sso.example.com)
//   HOIDC_PLATFORM_ID   - platform_id credential issued by SSO provider
export async function up(db: Kysely<any>): Promise<void> {
  const workspaceId = process.env.HOIDC_WORKSPACE_ID;
  const ssoApi = process.env.HOIDC_SSO_API;
  const platformId = process.env.HOIDC_PLATFORM_ID;

  if (!workspaceId || !ssoApi || !platformId) {
    console.warn(
      'Skipping HOIDC seed: HOIDC_WORKSPACE_ID, HOIDC_SSO_API and HOIDC_PLATFORM_ID must all be set.',
    );
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
      workspace_id: workspaceId,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  const workspaceId = process.env.HOIDC_WORKSPACE_ID;
  if (!workspaceId) return;

  await db
    .deleteFrom('auth_providers')
    .where('workspace_id', '=', workspaceId)
    .where('type', '=', 'hoidc')
    .execute();
}
