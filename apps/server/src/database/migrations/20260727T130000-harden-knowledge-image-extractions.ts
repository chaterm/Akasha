import { Kysely, sql } from 'kysely';

/**
 * Adds an atomic claim/lease lifecycle to image extraction.
 *
 * The original cache migration has already shipped to development databases,
 * so this is intentionally a forward migration instead of rewriting it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
      ALTER TABLE knowledge_image_extractions
        ADD COLUMN cache_fingerprint varchar,
        ADD COLUMN lease_token uuid,
        ADD COLUMN lease_expires_at timestamptz,
        ADD COLUMN retryable boolean,
        ADD COLUMN retry_after timestamptz,
        ADD COLUMN attempt_count integer NOT NULL DEFAULT 0;

      UPDATE knowledge_image_extractions
      SET
        cache_fingerprint = concat(
          'legacy:',
          md5(concat_ws(
            E'\\x1f',
            workspace_id::text,
            attachment_id::text,
            content_hash,
            model,
            prompt_version
          ))
        ),
        retryable = CASE WHEN status = 'failed' THEN false ELSE NULL END,
        error_code = CASE
          WHEN status = 'failed' THEN COALESCE(error_code, 'legacy_failure')
          ELSE error_code
        END,
        error_message = CASE
          WHEN status = 'failed' THEN COALESCE(
            error_message,
            'Legacy image extraction failed without diagnostic details.'
          )
          ELSE error_message
        END;

      ALTER TABLE knowledge_image_extractions
        ALTER COLUMN cache_fingerprint SET NOT NULL,
        DROP CONSTRAINT knowledge_image_extractions_cache_key_unique,
        DROP CONSTRAINT knowledge_image_extractions_status_check;

      ALTER TABLE knowledge_image_extractions
        ADD CONSTRAINT knowledge_image_extractions_cache_fingerprint_unique
          UNIQUE (workspace_id, attachment_id, cache_fingerprint),
        ADD CONSTRAINT knowledge_image_extractions_status_check
          CHECK (status IN ('processing', 'ready', 'failed')),
        ADD CONSTRAINT knowledge_image_extractions_attempt_count_check
          CHECK (attempt_count >= 0),
        ADD CONSTRAINT knowledge_image_extractions_lifecycle_check
          CHECK (
            (
              status = 'processing'
              AND lease_token IS NOT NULL
              AND lease_expires_at IS NOT NULL
              AND retryable IS NULL
              AND retry_after IS NULL
            )
            OR
            (
              status = 'ready'
              AND lease_token IS NULL
              AND lease_expires_at IS NULL
              AND retryable IS NULL
              AND retry_after IS NULL
            )
            OR
            (
              status = 'failed'
              AND lease_token IS NULL
              AND lease_expires_at IS NULL
              AND retryable IS NOT NULL
              AND error_code IS NOT NULL
              AND (
                (retryable = true AND retry_after IS NOT NULL)
                OR (retryable = false AND retry_after IS NULL)
              )
            )
          );

      CREATE INDEX knowledge_image_extractions_processing_lease_idx
        ON knowledge_image_extractions (lease_expires_at)
        WHERE status = 'processing';

      CREATE INDEX knowledge_image_extractions_failed_retry_idx
        ON knowledge_image_extractions (retry_after)
        WHERE status = 'failed' AND retryable = true;
      `,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
      DROP INDEX IF EXISTS knowledge_image_extractions_failed_retry_idx;
      DROP INDEX IF EXISTS knowledge_image_extractions_processing_lease_idx;

      ALTER TABLE knowledge_image_extractions
        DROP CONSTRAINT IF EXISTS knowledge_image_extractions_lifecycle_check,
        DROP CONSTRAINT IF EXISTS knowledge_image_extractions_attempt_count_check,
        DROP CONSTRAINT IF EXISTS knowledge_image_extractions_status_check,
        DROP CONSTRAINT IF EXISTS knowledge_image_extractions_cache_fingerprint_unique;

      UPDATE knowledge_image_extractions
      SET
        status = 'failed',
        ocr_text = NULL,
        caption = NULL,
        error_code = COALESCE(error_code, 'migration_rollback'),
        error_message = COALESCE(
          error_message,
          'Image extraction was interrupted by a schema rollback.'
        )
      WHERE status = 'processing';

      WITH duplicate_rows AS (
        SELECT id
        FROM (
          SELECT
            id,
            row_number() OVER (
              PARTITION BY
                workspace_id,
                attachment_id,
                content_hash,
                model,
                prompt_version
              ORDER BY (status = 'ready') DESC, updated_at DESC, id DESC
            ) AS duplicate_rank
          FROM knowledge_image_extractions
        ) ranked
        WHERE duplicate_rank > 1
      )
      DELETE FROM knowledge_image_extractions extraction
      USING duplicate_rows duplicate
      WHERE extraction.id = duplicate.id;

      ALTER TABLE knowledge_image_extractions
        DROP COLUMN IF EXISTS attempt_count,
        DROP COLUMN IF EXISTS retry_after,
        DROP COLUMN IF EXISTS retryable,
        DROP COLUMN IF EXISTS lease_expires_at,
        DROP COLUMN IF EXISTS lease_token,
        DROP COLUMN IF EXISTS cache_fingerprint,
        ADD CONSTRAINT knowledge_image_extractions_cache_key_unique
          UNIQUE (
            workspace_id,
            attachment_id,
            content_hash,
            model,
            prompt_version
          ),
        ADD CONSTRAINT knowledge_image_extractions_status_check
          CHECK (status IN ('ready', 'failed'));
      `,
    )
    .execute(db);
}
