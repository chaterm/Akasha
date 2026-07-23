import { Kysely, sql } from 'kysely';

/**
 * Correct personal spaces missed by the first ownership migration when the
 * user changed their display name after the legacy space was created.
 *
 * The first migration's generated replacement is retained as a regular space,
 * so this repair never deletes content that may have been added meanwhile.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    WITH ranked_legacy_candidates AS (
      SELECT
        legacy.id AS legacy_space_id,
        generated.id AS generated_space_id,
        u.id AS user_id,
        ROW_NUMBER() OVER (
          PARTITION BY u.workspace_id, u.id
          ORDER BY legacy.created_at ASC, legacy.id ASC
        ) AS candidate_rank
      FROM users AS u
      INNER JOIN spaces AS generated
        ON generated.workspace_id = u.workspace_id
        AND generated.personal_owner_id = u.id
        AND generated.deleted_at IS NULL
        AND generated.slug = CONCAT('personal-', generated.id::text)
      INNER JOIN spaces AS legacy
        ON legacy.workspace_id = u.workspace_id
        AND legacy.creator_id = u.id
        AND legacy.personal_owner_id IS NULL
        AND legacy.deleted_at IS NULL
        AND legacy.id <> generated.id
      WHERE u.workspace_id IS NOT NULL
        AND u.deleted_at IS NULL
        AND RIGHT(
          legacy.name,
          LENGTH(CONCAT('(', u.email, ')'))
        ) = CONCAT('(', u.email, ')')
    ),
    released_generated_spaces AS (
      UPDATE spaces AS generated
      SET personal_owner_id = NULL,
          updated_at = NOW()
      FROM ranked_legacy_candidates AS candidate
      WHERE candidate.candidate_rank = 1
        AND generated.id = candidate.generated_space_id
      RETURNING generated.id
    ),
    claimed_legacy_spaces AS (
      UPDATE spaces AS legacy
      SET personal_owner_id = candidate.user_id,
          updated_at = NOW()
      FROM ranked_legacy_candidates AS candidate
      WHERE candidate.candidate_rank = 1
        AND legacy.id = candidate.legacy_space_id
        AND EXISTS (
          SELECT 1
          FROM released_generated_spaces AS released
          WHERE released.id = candidate.generated_space_id
        )
      RETURNING legacy.id, legacy.personal_owner_id
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
    FROM claimed_legacy_spaces
    ON CONFLICT (space_id, user_id)
    DO UPDATE SET
      role = 'admin',
      deleted_at = NULL,
      updated_at = NOW()
  `.execute(db);
}

export async function down(_db: Kysely<any>): Promise<void> {
  // This is a conservative data correction. Reversing it would reintroduce
  // the incorrect ownership assignment and cannot be done safely after use.
}
