import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('users')
    .addUniqueConstraint('users_id_workspace_unique', ['id', 'workspace_id'])
    .execute();

  await db.schema
    .alterTable('spaces')
    .addColumn('personal_owner_id', 'uuid')
    .execute();

  await db.schema
    .alterTable('spaces')
    .addForeignKeyConstraint(
      'spaces_personal_owner_workspace_fk',
      ['personal_owner_id', 'workspace_id'],
      'users',
      ['id', 'workspace_id'],
    )
    .execute();

  // Preserve legacy personal spaces conservatively. If more than one space
  // matches the historical naming convention, only the oldest is claimed.
  await sql`
    WITH ranked_candidates AS (
      SELECT
        s.id AS space_id,
        u.id AS user_id,
        ROW_NUMBER() OVER (
          PARTITION BY s.workspace_id, u.id
          ORDER BY s.created_at ASC, s.id ASC
        ) AS candidate_rank
      FROM spaces AS s
      INNER JOIN users AS u
        ON u.id = s.creator_id
        AND u.workspace_id = s.workspace_id
      WHERE s.deleted_at IS NULL
        AND u.deleted_at IS NULL
        AND (
          s.name = u.email
          OR s.name = CONCAT(u.name, '(', u.email, ')')
        )
    )
    UPDATE spaces AS s
    SET personal_owner_id = candidate.user_id,
        updated_at = NOW()
    FROM ranked_candidates AS candidate
    WHERE candidate.candidate_rank = 1
      AND s.id = candidate.space_id
  `.execute(db);

  // The owner must always have a direct admin membership, even if a legacy
  // record was soft-deleted or granted a weaker role.
  await sql`
    INSERT INTO space_members (
      user_id,
      space_id,
      role,
      added_by_id
    )
    SELECT
      personal_owner_id,
      id,
      'admin',
      personal_owner_id
    FROM spaces
    WHERE personal_owner_id IS NOT NULL
      AND deleted_at IS NULL
    ON CONFLICT (space_id, user_id)
    DO UPDATE SET
      role = 'admin',
      deleted_at = NULL,
      updated_at = NOW()
  `.execute(db);

  // Materialize the invariant for every current workspace user so existing
  // sessions and API keys do not depend on a future login repair.
  await sql`
    WITH users_without_personal_space AS (
      SELECT
        u.id,
        u.workspace_id,
        u.name,
        u.email,
        u.avatar_url
      FROM users AS u
      WHERE u.workspace_id IS NOT NULL
        AND u.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM spaces AS s
          WHERE s.workspace_id = u.workspace_id
            AND s.personal_owner_id = u.id
            AND s.deleted_at IS NULL
        )
    ),
    prepared_spaces AS (
      SELECT
        gen_uuid_v7() AS id,
        CASE
          WHEN name IS NOT NULL AND name <> ''
            THEN CONCAT(name, '(', email, ')')
          ELSE email
        END AS name,
        email,
        avatar_url,
        id AS user_id,
        workspace_id
      FROM users_without_personal_space
    ),
    inserted_spaces AS (
      INSERT INTO spaces (
        id,
        name,
        slug,
        logo,
        creator_id,
        personal_owner_id,
        workspace_id
      )
      SELECT
        id,
        name,
        CONCAT('personal-', id::text),
        avatar_url,
        user_id,
        user_id,
        workspace_id
      FROM prepared_spaces
      RETURNING id, personal_owner_id
    )
    INSERT INTO space_members (
      user_id,
      space_id,
      role,
      added_by_id
    )
    SELECT
      personal_owner_id,
      id,
      'admin',
      personal_owner_id
    FROM inserted_spaces
  `.execute(db);

  await db.schema
    .alterTable('spaces')
    .addUniqueConstraint('spaces_workspace_personal_owner_unique', [
      'workspace_id',
      'personal_owner_id',
    ])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('spaces')
    .dropConstraint('spaces_personal_owner_workspace_fk')
    .execute();

  await db.schema
    .alterTable('spaces')
    .dropConstraint('spaces_workspace_personal_owner_unique')
    .execute();

  await db.schema
    .alterTable('spaces')
    .dropColumn('personal_owner_id')
    .execute();

  await db.schema
    .alterTable('users')
    .dropConstraint('users_id_workspace_unique')
    .execute();
}
