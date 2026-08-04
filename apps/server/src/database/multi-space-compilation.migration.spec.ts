import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const migrationPath = resolve(
  __dirname,
  'migrations/20260731T100000-multi-space-compilation.ts',
);
const persistedPlanMigrationPath = resolve(
  __dirname,
  'migrations/20260803T100000-persist-knowledge-run-plan.ts',
);
const databaseTypesPath = resolve(__dirname, 'types/db.d.ts');
const entityTypesPath = resolve(__dirname, 'types/entity.types.ts');

describe('multi-space compilation migration contract', () => {
  it('adds durable space dispatch, lease and yield state without duplicating skips', async () => {
    const migration = await readFile(migrationPath, 'utf8');

    for (const column of [
      'initialized_at',
      'space_job_id',
      'space_job_dispatched_at',
      'space_job_sequence',
      'space_job_queued_at',
      'space_job_recovery_count',
      'execution_token',
      'execution_lease_expires_at',
      'worker_id',
      'heartbeat_at',
      'last_yield_at',
      'last_yield_reason',
      'rerun_requested',
    ]) {
      expect(migration).toContain(`.addColumn('${column}'`);
    }
    expect(migration).toContain("'image_merge'");
    expect(migration).not.toContain(".addColumn('skipped_image_count'");
    expect(migration).toContain('space_job_sequence >= 0');
    expect(migration).toContain('space_job_recovery_count BETWEEN 0 AND 3');
  });

  it('creates the frozen single-image outbox with all fences and indexes', async () => {
    const migration = await readFile(migrationPath, 'utf8');

    expect(migration).toContain(
      ".createTable('knowledge_space_compile_run_images')",
    );
    for (const column of [
      'run_id',
      'run_page_id',
      'workspace_id',
      'space_id',
      'source_page_id',
      'attachment_id',
      'image_ordinal',
      'file_name',
      'mime_type',
      'file_size',
      'alt_text',
      'expected_attachment_version',
      'status',
      'job_id',
      'dispatched_at',
      'processing_expires_at',
      'extraction_id',
      'attempt_count',
      'redis_recovery_count',
      'failure_class',
      'error_code',
      'error_message',
      'created_at',
      'updated_at',
    ]) {
      expect(migration).toContain(`.addColumn('${column}'`);
    }
    expect(migration).toContain(
      'uq_knowledge_space_compile_run_images_run_source_attachment',
    );
    expect(migration).toContain(
      'uq_knowledge_space_compile_run_images_page_ordinal',
    );
    expect(migration).toContain('uq_knowledge_space_compile_run_images_job_id');
    expect(migration).toContain('image_ordinal BETWEEN 0 AND 49');
    expect(migration).toContain('redis_recovery_count BETWEEN 0 AND 3');
    expect(migration).toContain(
      "failure_class IN ('retryable_exhausted', 'permanent')",
    );
    expect(migration).toContain("status = 'failed' OR failure_class IS NULL");
    expect(migration).toContain(
      "status != 'failed' OR failure_class IS NOT NULL",
    );
  });

  it('keeps generated Kysely contracts aligned with the additive schema', async () => {
    const [databaseTypes, entityTypes, persistedPlanMigration] =
      await Promise.all([
        readFile(databaseTypesPath, 'utf8'),
        readFile(entityTypesPath, 'utf8'),
        readFile(persistedPlanMigrationPath, 'utf8'),
      ]);
    const runs = interfaceBody(databaseTypes, 'KnowledgeSpaceCompileRuns');
    const images = interfaceBody(
      databaseTypes,
      'KnowledgeSpaceCompileRunImages',
    );
    const database = interfaceBody(databaseTypes, 'DB');

    expect(runs).toContain('initializedAt: Timestamp | null;');
    expect(runs).toContain('aggregateRequired: Generated<boolean>;');
    expect(runs).toContain('spaceJobSequence: Generated<number>;');
    expect(runs).toContain('spaceJobRecoveryCount: Generated<number>;');
    expect(runs).toContain('executionToken: string | null;');
    expect(runs).toContain('executionLeaseExpiresAt: Timestamp | null;');
    expect(runs).toContain('rerunRequested: Generated<boolean>;');
    expect(images).toContain('imageOrdinal: number;');
    expect(images).toContain('fileSize: Int8 | null;');
    expect(images).toContain('expectedAttachmentVersion: Timestamp;');
    expect(images).toContain('failureClass: string | null;');
    expect(images).toContain('redisRecoveryCount: Generated<number>;');
    expect(database).toContain(
      'knowledgeSpaceCompileRunImages: KnowledgeSpaceCompileRunImages;',
    );
    expect(entityTypes).toContain('Selectable<KnowledgeSpaceCompileRunImages>');
    expect(persistedPlanMigration).toContain(
      ".addColumn('aggregate_required', 'boolean'",
    );
    expect(persistedPlanMigration).toContain(
      'column.notNull().defaultTo(true)',
    );
  });
});

function interfaceBody(source: string, interfaceName: string): string {
  const match = source.match(
    new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`),
  );
  expect(match).toBeTruthy();
  return match?.[1] ?? '';
}
