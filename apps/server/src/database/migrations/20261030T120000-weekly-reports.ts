import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE weekly_report_records (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL, user_id uuid NOT NULL,
      space_id uuid NOT NULL, parent_page_id uuid NOT NULL, page_id uuid NOT NULL,
      period_start date NOT NULL, period_end date NOT NULL,
      timezone text NOT NULL, template_id uuid NOT NULL, template_fingerprint text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT weekly_report_period_order CHECK (period_start <= period_end),
      CONSTRAINT weekly_report_business_key UNIQUE
        (workspace_id, user_id, space_id, parent_page_id, period_start, period_end)
    )
  `.execute(db);
  // Retain identities after a source Page is deleted; never recreate on replay.
  await sql`
    CREATE TABLE weekly_report_save_receipts (
      save_id uuid NOT NULL, workspace_id uuid NOT NULL, user_id uuid NOT NULL,
      report_record_id uuid NOT NULL REFERENCES weekly_report_records(id),
      parent_created boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, user_id, save_id)
    )
  `.execute(db);
  await sql`
    CREATE TABLE weekly_report_outbox (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, page_id uuid NOT NULL, user_id uuid NOT NULL,
      effect text NOT NULL CHECK (effect IN ('search','access','compile','watchers','audit')),
      attempts integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (page_id, effect)
    )
  `.execute(db);
  await sql`CREATE INDEX weekly_report_outbox_pending ON weekly_report_outbox(available_at) WHERE delivered_at IS NULL`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE weekly_report_outbox`.execute(db);
  await sql`DROP TABLE weekly_report_save_receipts`.execute(db);
  await sql`DROP TABLE weekly_report_records`.execute(db);
}
