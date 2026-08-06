import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { KnowledgeSpaceCompilationRepo } from './knowledge-space-compilation.repo';

const databaseUrl = process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('force-reset PostgreSQL scope', () => {
  const schema = `akasha_force_reset_${process.pid}_${Date.now()}`;
  let client: ReturnType<typeof postgres>;
  let db: Kysely<unknown>;
  let repo: KnowledgeSpaceCompilationRepo;

  beforeAll(async () => {
    client = postgres(normalizePostgresUrl(databaseUrl!), {
      max: 1,
      onnotice: () => {},
    });
    db = new Kysely({
      dialect: new PostgresJSDialect({ postgres: client }),
      plugins: [new CamelCasePlugin()],
    });
    await sql.raw(`create schema "${schema}"`).execute(db);
    await sql.raw(`set search_path to "${schema}"`).execute(db);
    await createFixture(db);
    repo = new KnowledgeSpaceCompilationRepo(db as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  it('increments once, fences old runs, purges only compiled state, and retains history/source data', async () => {
    const before = await evidence(db);
    const result = await repo.forceResetAndCreateRun({
      workspaceId: 'workspace-1',
      spaceId: 'space-target',
      confirmationSpaceName: 'Target Space',
      trigger: 'manual_compile',
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
      catalogSnapshot: [],
      catalogHash: 'sha256:reset',
      sources: [
        {
          sourcePageId: 'page-target',
          sourceVersion: 'v2',
          sourceContentHash: 'sha256:v2',
          expectedImageCount: 1,
        },
      ],
    });
    const after = await evidence(db);

    expect(result).toEqual(
      expect.objectContaining({
        reset: true,
        generation: 4,
        supersededRunIds: ['run-old'],
        supersededJobIds: expect.arrayContaining([
          'space-old',
          'page-old',
          'image-old',
          'merge-old',
          'aggregate-old',
          'run-image-succeeded',
          'run-image-processing',
        ]),
        run: expect.objectContaining({
          mode: 'force_rebuild',
          knowledgeGeneration: 4,
        }),
      }),
    );
    expect(before).toEqual(
      expect.objectContaining({
        generation: 3,
        targetCompiled: 8,
        controlCompiled: 8,
        sourcePages: 2,
        attachments: 2,
        attempts: 2,
        history: 3,
        targetDelayed: 1,
        controlDelayed: 1,
      }),
    );
    expect(after).toEqual(
      expect.objectContaining({
        generation: 4,
        targetCompiled: 0,
        controlCompiled: 8,
        sourcePages: 2,
        attachments: 2,
        attempts: 2,
        history: 3,
        oldRunStatus: 'superseded',
        oldRunPhase: 'complete',
        oldRunHasLease: false,
        oldRunRerunRequested: false,
        oldRunSkippedPages: 1,
        oldPageStatus: 'skipped',
        oldPageImageStatus: 'partial',
        oldPageMergeStatus: 'skipped',
        oldPageSucceededImages: 1,
        oldPageSkippedImages: 1,
        oldProcessingImageStatus: 'skipped',
        openChildStates: 0,
        resetTaskId: 'force-reset:4',
        resetLastHash: null,
        newRunGeneration: 4,
        newRunPages: 1,
        targetDelayed: 0,
        controlDelayed: 1,
      }),
    );
    if (process.env.AKASHA_MIGRATION_TEST_EVIDENCE === '1') {
      console.info(
        'knowledge_force_reset_database_evidence',
        JSON.stringify({ before, after }),
      );
    }
  });

  it('rejects a stale exact-name confirmation without changing the database', async () => {
    const before = await evidence(db);
    await expect(
      repo.forceResetAndCreateRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-control',
        confirmationSpaceName: ' Control Space',
        trigger: 'manual_compile',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
        catalogSnapshot: [],
        catalogHash: 'hash',
        sources: [],
      }),
    ).resolves.toEqual({ reset: false, reason: 'space_name_mismatch' });
    expect(await evidence(db)).toEqual(before);
  });
});

async function createFixture(db: Kysely<unknown>): Promise<void> {
  await sql`
    create sequence run_seq;
    create sequence run_page_seq;
    create table spaces (
      id varchar primary key, workspace_id varchar not null, name varchar,
      knowledge_generation integer not null default 0,
      deleted_at timestamptz, updated_at timestamptz not null default now()
    );
    create table pages (id varchar primary key, workspace_id varchar not null, space_id varchar not null);
    create table knowledge_page_compile_schedules (
      id varchar primary key, workspace_id varchar not null,
      space_id varchar not null, source_page_id varchar not null,
      trigger varchar not null, change_count integer not null default 1,
      first_changed_at timestamptz not null,
      last_changed_at timestamptz not null, eligible_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (workspace_id, source_page_id)
    );
    create table attachments (id varchar primary key, workspace_id varchar not null, space_id varchar, page_id varchar);
    create table knowledge_space_compile_runs (
      id varchar primary key default ('run-' || nextval('run_seq')),
      workspace_id varchar not null, space_id varchar not null, trigger varchar not null,
      mode varchar not null, knowledge_generation integer not null, phase varchar not null,
      status varchar not null, expected_page_count integer not null,
      succeeded_page_count integer not null default 0, failed_page_count integer not null default 0,
      skipped_page_count integer not null default 0, compiler_version varchar not null,
      prompt_version varchar not null, catalog_snapshot jsonb not null, catalog_hash varchar not null,
      aggregate_job_id varchar, imported_artifact_count integer not null default 0,
      quarantined_artifact_count integer not null default 0, error_code varchar, error_message varchar,
      queued_at timestamptz not null, started_at timestamptz, aggregate_started_at timestamptz,
      finished_at timestamptz, initialized_at timestamptz, space_job_id varchar,
      space_job_dispatched_at timestamptz, space_job_sequence integer not null default 0,
      space_job_queued_at timestamptz, space_job_recovery_count integer not null default 0,
      execution_token varchar, execution_lease_expires_at timestamptz, worker_id varchar,
      heartbeat_at timestamptz, last_yield_at timestamptz, last_yield_reason varchar,
      rerun_requested boolean not null default false,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create table knowledge_space_compile_run_pages (
      id varchar primary key default ('rp-' || nextval('run_page_seq')), run_id varchar not null,
      workspace_id varchar not null, space_id varchar not null, source_page_id varchar not null,
      expected_source_version varchar not null, expected_source_content_hash varchar not null,
      expected_image_count integer not null default 0, succeeded_image_count integer not null default 0,
      failed_image_count integer not null default 0, skipped_image_count integer not null default 0,
      image_status varchar not null default 'not_required',
      image_job_id varchar, merge_status varchar not null default 'not_required', merge_job_id varchar,
      target_effective_knowledge_hash varchar, merged_effective_knowledge_hash varchar,
      status varchar not null, job_id varchar, error_code varchar, error_message varchar,
      queued_at timestamptz, started_at timestamptz, finished_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create table knowledge_space_compile_run_images (
      id varchar primary key, run_id varchar not null, run_page_id varchar not null,
      workspace_id varchar not null, space_id varchar not null, source_page_id varchar not null,
      status varchar not null, failure_class varchar, job_id varchar,
      processing_expires_at timestamptz, error_code varchar, error_message varchar,
      updated_at timestamptz not null default now()
    );
    create table knowledge_pages (id varchar primary key, workspace_id varchar not null, space_id varchar not null);
    create table knowledge_claims (id varchar primary key, knowledge_page_id varchar references knowledge_pages(id) on delete cascade);
    create table knowledge_chunks (id varchar primary key, knowledge_page_id varchar references knowledge_pages(id) on delete cascade);
    create table knowledge_links (id varchar primary key, from_knowledge_page_id varchar references knowledge_pages(id) on delete cascade);
    create table knowledge_graph_edges (id varchar primary key, from_knowledge_page_id varchar references knowledge_pages(id) on delete cascade);
    create table knowledge_parent_sections (id varchar primary key, knowledge_page_id varchar references knowledge_pages(id) on delete cascade);
    create table knowledge_artifact_contributions (id varchar primary key, workspace_id varchar not null, space_id varchar not null);
    create table knowledge_sources (id varchar primary key, workspace_id varchar not null, source_space_id varchar not null);
    create table knowledge_source_chunks (id varchar primary key, source_id varchar references knowledge_sources(id) on delete cascade);
    create table knowledge_source_analyses (id varchar primary key, workspace_id varchar not null, space_id varchar not null, source_page_id varchar not null);
    create table knowledge_quarantined_artifacts (id varchar primary key, workspace_id varchar not null, space_id varchar not null);
    create table knowledge_image_extractions (id varchar primary key, workspace_id varchar not null, attachment_id varchar not null);
    create table knowledge_source_access_policy (workspace_id varchar not null, source_page_id varchar not null, source_space_id varchar not null, primary key(workspace_id, source_page_id));
    create table knowledge_source_access_requirements (workspace_id varchar not null, source_page_id varchar not null);
    create table knowledge_source_access_principals (workspace_id varchar not null, source_page_id varchar not null);
    create table knowledge_compilation_attempts (
      id varchar primary key, workspace_id varchar not null, space_id varchar not null,
      status varchar not null, stage varchar not null, compile_task_id varchar,
      effective_knowledge_hash varchar, last_successful_effective_hash varchar,
      last_successful_source_version varchar, last_successful_source_hash varchar,
      pending_import jsonb, pending_space_id varchar,
      pending_source_version varchar, pending_effective_knowledge_hash varchar,
      pending_created_at timestamptz,
      error_code varchar, error_message varchar, updated_at timestamptz not null default now()
    );
    create table knowledge_query_audit (id varchar primary key);
    create table knowledge_review_snapshots (id varchar primary key);

    insert into spaces values
      ('space-target','workspace-1','Target Space',3,null,now()),
      ('space-control','workspace-1','Control Space',7,null,now()),
      ('space-cross','workspace-2','Target Space',11,null,now());
    insert into pages values ('page-target','workspace-1','space-target'),('page-control','workspace-1','space-control');
    insert into knowledge_page_compile_schedules (
      id, workspace_id, space_id, source_page_id, trigger,
      first_changed_at, last_changed_at, eligible_at
    ) values
      ('delay-target','workspace-1','space-target','page-target','page_updated',now(),now(),now() + interval '1 hour'),
      ('delay-control','workspace-1','space-control','page-control','page_updated',now(),now(),now() + interval '1 hour');
    insert into attachments values ('attachment-target','workspace-1','space-target','page-target'),('attachment-control','workspace-1','space-control','page-control');
    insert into knowledge_space_compile_runs (id,workspace_id,space_id,trigger,mode,knowledge_generation,phase,status,expected_page_count,compiler_version,prompt_version,catalog_snapshot,catalog_hash,aggregate_job_id,queued_at,space_job_id,space_job_dispatched_at,execution_token,execution_lease_expires_at,worker_id,heartbeat_at,rerun_requested)
      values ('run-old','workspace-1','space-target','manual_compile','incremental',3,'text','compiling',1,'c','p','[]','h','aggregate-old',now(),'space-old',now(),'old-token',now() + interval '3 minutes','old-worker',now(),true);
    insert into knowledge_space_compile_run_pages (id,run_id,workspace_id,space_id,source_page_id,expected_source_version,expected_source_content_hash,expected_image_count,succeeded_image_count,image_status,image_job_id,merge_status,merge_job_id,status,job_id)
      values ('rp-old','run-old','workspace-1','space-target','page-target','v1','h1',2,1,'queued','image-old','queued','merge-old','running','page-old');
    insert into knowledge_space_compile_run_images (id,run_id,run_page_id,workspace_id,space_id,source_page_id,status,failure_class,job_id,processing_expires_at)
      values
        ('image-succeeded','run-old','rp-old','workspace-1','space-target','page-target','succeeded',null,'run-image-succeeded',null),
        ('image-processing','run-old','rp-old','workspace-1','space-target','page-target','processing',null,'run-image-processing',now() + interval '3 minutes');
    insert into knowledge_pages values ('kp-target','workspace-1','space-target'),('kp-control','workspace-1','space-control');
    insert into knowledge_claims values ('claim-target','kp-target'),('claim-control','kp-control');
    insert into knowledge_chunks values ('chunk-target','kp-target'),('chunk-control','kp-control');
    insert into knowledge_links values ('link-target','kp-target'),('link-control','kp-control');
    insert into knowledge_graph_edges values ('edge-target','kp-target'),('edge-control','kp-control');
    insert into knowledge_parent_sections values ('section-target','kp-target'),('section-control','kp-control');
    insert into knowledge_artifact_contributions values ('contrib-target','workspace-1','space-target'),('contrib-control','workspace-1','space-control');
    insert into knowledge_sources values ('source-target','workspace-1','space-target'),('source-control','workspace-1','space-control');
    insert into knowledge_source_chunks values ('source-chunk-target','source-target'),('source-chunk-control','source-control');
    insert into knowledge_source_analyses values ('analysis-target','workspace-1','space-target','page-target'),('analysis-control','workspace-1','space-control','page-control');
    insert into knowledge_quarantined_artifacts values ('quarantine-target','workspace-1','space-target'),('quarantine-control','workspace-1','space-control');
    insert into knowledge_image_extractions values ('image-target','workspace-1','attachment-target'),('image-control','workspace-1','attachment-control');
    insert into knowledge_source_access_policy values ('workspace-1','page-target','space-target'),('workspace-1','page-control','space-control');
    insert into knowledge_source_access_requirements values ('workspace-1','page-target'),('workspace-1','page-control');
    insert into knowledge_source_access_principals values ('workspace-1','page-target'),('workspace-1','page-control');
    insert into knowledge_compilation_attempts values
      ('attempt-target','workspace-1','space-target','succeeded','completed','task-old','effective','effective','v1','h1',null,null,now()),
      ('attempt-control','workspace-1','space-control','succeeded','completed','task-control','effective-control','effective-control','v1','h1',null,null,now());
    insert into knowledge_query_audit values ('query-history');
    insert into knowledge_review_snapshots values ('review-history');
  `.execute(db);
}

async function evidence(db: Kysely<unknown>) {
  const result = await sql<Record<string, unknown>>`
    select
      (select knowledge_generation from spaces where id='space-target')::integer as generation,
      (select count(*) from pages)::integer as "sourcePages",
      (select count(*) from attachments)::integer as attachments,
      (select count(*) from knowledge_page_compile_schedules where space_id='space-target')::integer as "targetDelayed",
      (select count(*) from knowledge_page_compile_schedules where space_id='space-control')::integer as "controlDelayed",
      (select count(*) from knowledge_compilation_attempts)::integer as attempts,
      ((select count(*) from knowledge_query_audit) + (select count(*) from knowledge_review_snapshots) + (select count(*) from knowledge_space_compile_runs where id='run-old'))::integer as history,
      ((select count(*) from knowledge_pages where space_id='space-target') +
       (select count(*) from knowledge_artifact_contributions where space_id='space-target') +
       (select count(*) from knowledge_sources where source_space_id='space-target') +
       (select count(*) from knowledge_source_analyses where space_id='space-target') +
       (select count(*) from knowledge_quarantined_artifacts where space_id='space-target') +
       (select count(*) from knowledge_image_extractions where attachment_id='attachment-target') +
       (select count(*) from knowledge_source_access_policy where source_space_id='space-target') +
       (select count(*) from knowledge_source_access_requirements where source_page_id='page-target'))::integer as "targetCompiled",
      ((select count(*) from knowledge_pages where space_id='space-control') +
       (select count(*) from knowledge_artifact_contributions where space_id='space-control') +
       (select count(*) from knowledge_sources where source_space_id='space-control') +
       (select count(*) from knowledge_source_analyses where space_id='space-control') +
       (select count(*) from knowledge_quarantined_artifacts where space_id='space-control') +
       (select count(*) from knowledge_image_extractions where attachment_id='attachment-control') +
       (select count(*) from knowledge_source_access_policy where source_space_id='space-control') +
       (select count(*) from knowledge_source_access_requirements where source_page_id='page-control'))::integer as "controlCompiled",
      (select status from knowledge_space_compile_runs where id='run-old') as "oldRunStatus",
      (select phase from knowledge_space_compile_runs where id='run-old') as "oldRunPhase",
      (select execution_token is not null or execution_lease_expires_at is not null or worker_id is not null from knowledge_space_compile_runs where id='run-old') as "oldRunHasLease",
      (select rerun_requested from knowledge_space_compile_runs where id='run-old') as "oldRunRerunRequested",
      (select skipped_page_count from knowledge_space_compile_runs where id='run-old')::integer as "oldRunSkippedPages",
      (select status from knowledge_space_compile_run_pages where id='rp-old') as "oldPageStatus",
      (select image_status from knowledge_space_compile_run_pages where id='rp-old') as "oldPageImageStatus",
      (select merge_status from knowledge_space_compile_run_pages where id='rp-old') as "oldPageMergeStatus",
      (select succeeded_image_count from knowledge_space_compile_run_pages where id='rp-old')::integer as "oldPageSucceededImages",
      (select skipped_image_count from knowledge_space_compile_run_pages where id='rp-old')::integer as "oldPageSkippedImages",
      (select status from knowledge_space_compile_run_images where id='image-processing') as "oldProcessingImageStatus",
      ((select count(*) from knowledge_space_compile_run_pages where run_id='run-old' and (status in ('pending','queued','running') or image_status in ('pending','queued','processing') or merge_status in ('waiting_images','pending','queued','running'))) +
       (select count(*) from knowledge_space_compile_run_images where run_id='run-old' and status in ('pending','queued','processing')))::integer as "openChildStates",
      (select compile_task_id from knowledge_compilation_attempts where id='attempt-target') as "resetTaskId",
      (select last_successful_source_hash from knowledge_compilation_attempts where id='attempt-target') as "resetLastHash",
      (select max(knowledge_generation) from knowledge_space_compile_runs where space_id='space-target')::integer as "newRunGeneration",
      (select count(*) from knowledge_space_compile_run_pages where run_id <> 'run-old')::integer as "newRunPages"
  `.execute(db);
  return result.rows[0];
}
