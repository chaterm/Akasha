import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CompiledQuery,
  DatabaseConnection,
  Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  QueryResult,
} from 'kysely';
import {
  clearPreBaselineMigrationHistory,
  readMigrationNamesOnDisk,
} from './prune-migration-history';

function fakeDb(options: { tableExists: boolean; recorded: string[] }) {
  const executed: string[] = [];

  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = compiled.sql.trim();
      executed.push(text);
      if (text.includes('information_schema.tables')) {
        return {
          rows: [{ exists: options.tableExists }] as unknown as R[],
        };
      }
      if (text.startsWith('SELECT name')) {
        return {
          rows: options.recorded.map((name) => ({ name })) as unknown as R[],
        };
      }
      if (text.startsWith('DELETE')) {
        return {
          rows: [],
          numAffectedRows: BigInt(options.recorded.length),
        };
      }
      throw new Error(`unexpected statement: ${text}`);
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not supported');
    },
  };

  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };

  const db = new Kysely<any>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (instance) => new PostgresIntrospector(instance),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  openDbs.push(db);

  return { db, executed };
}

const openDbs: Kysely<any>[] = [];

afterEach(async () => {
  await Promise.all(openDbs.splice(0).map((db) => db.destroy()));
});

describe('readMigrationNamesOnDisk', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'akasha-migrations-'));
  });

  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  it('keeps migration modules and ignores assets and type declarations', async () => {
    for (const name of [
      '20261021T000000-baseline-v1.js',
      '20261021T000000-baseline-v1.sql',
      '20261021T000000-baseline-v1.d.ts',
      '20261022T100000-index.js',
      '20261022T100000-index.js.map',
      'notes.md',
    ]) {
      await fs.writeFile(path.join(folder, name), '');
    }

    expect([...(await readMigrationNamesOnDisk(folder))].sort()).toEqual([
      '20261021T000000-baseline-v1',
      '20261022T100000-index',
    ]);
  });
});

describe('clearPreBaselineMigrationHistory', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'akasha-migrations-'));
    await fs.writeFile(
      path.join(folder, '20261021T000000-baseline-v1.js'),
      '',
    );
  });

  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  it('does nothing when the migration table does not exist', async () => {
    const { db, executed } = fakeDb({ tableExists: false, recorded: [] });

    await expect(
      clearPreBaselineMigrationHistory(db as never, {
        migrationFolder: folder,
      }),
    ).resolves.toEqual({ cleared: false, recorded: 0, deleted: 0 });
    expect(executed.some((it) => it.includes('DELETE'))).toBe(false);
  });

  it('refuses to prune when no migrations shipped', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'akasha-empty-'));
    const { db, executed } = fakeDb({
      tableExists: true,
      recorded: ['20251001T000000-old'],
    });

    try {
      await expect(
        clearPreBaselineMigrationHistory(db as never, {
          migrationFolder: empty,
        }),
      ).rejects.toThrow('Refusing to prune migration history');
      expect(executed.some((it) => it.includes('DELETE'))).toBe(false);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it('leaves a consistent history alone', async () => {
    const { db, executed } = fakeDb({
      tableExists: true,
      recorded: ['20261021T000000-baseline-v1'],
    });

    await expect(
      clearPreBaselineMigrationHistory(db as never, {
        migrationFolder: folder,
      }),
    ).resolves.toEqual({ cleared: false, recorded: 1, deleted: 0 });
    expect(executed.some((it) => it.includes('DELETE'))).toBe(false);
  });

  it('leaves a mixed history alone', async () => {
    const { db, executed } = fakeDb({
      tableExists: true,
      recorded: ['20251001T000000-old', '20261021T000000-baseline-v1'],
    });

    await expect(
      clearPreBaselineMigrationHistory(db as never, {
        migrationFolder: folder,
      }),
    ).resolves.toEqual({ cleared: false, recorded: 2, deleted: 0 });
    expect(executed.some((it) => it.includes('DELETE'))).toBe(false);
  });

  it('reports without deleting on a dry run', async () => {
    const { db, executed } = fakeDb({
      tableExists: true,
      recorded: ['20251001T000000-old', '20251002T000000-older'],
    });

    await expect(
      clearPreBaselineMigrationHistory(db as never, {
        migrationFolder: folder,
        dryRun: true,
      }),
    ).resolves.toEqual({ cleared: true, recorded: 2, deleted: 0 });
    expect(executed.some((it) => it.includes('DELETE'))).toBe(false);
  });

  it('clears a fully pre-baseline history', async () => {
    const { db, executed } = fakeDb({
      tableExists: true,
      recorded: ['20251001T000000-old', '20251002T000000-older'],
    });

    await expect(
      clearPreBaselineMigrationHistory(db as never, {
        migrationFolder: folder,
      }),
    ).resolves.toEqual({ cleared: true, recorded: 2, deleted: 2 });
    expect(executed.some((it) => it.includes('DELETE'))).toBe(true);
  });

  it('clears the 110-row pre-baseline history of a v0 production database', async () => {
    const shipped = path.join(__dirname, 'migrations');
    const onDisk = await readMigrationNamesOnDisk(shipped);
    const recorded = Array.from(
      { length: 110 },
      (_, i) => `20250101T${String(i).padStart(6, '0')}-pre-baseline`,
    );
    expect(recorded.some((name) => onDisk.has(name))).toBe(false);

    const { db } = fakeDb({ tableExists: true, recorded });

    await expect(
      clearPreBaselineMigrationHistory(db as never, {
        migrationFolder: shipped,
      }),
    ).resolves.toEqual({ cleared: true, recorded: 110, deleted: 110 });
  });
});
