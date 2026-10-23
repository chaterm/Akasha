import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { MigrationService } from './migration.service';

type ServiceDb = ConstructorParameters<typeof MigrationService>[0];

function buildDb() {
  const connection = { __connection: true };
  const db = {
    connection: () => ({
      execute: (callback: (connection: unknown) => Promise<unknown>) =>
        callback(connection),
    }),
  };
  return { db: db as unknown as ServiceDb, connection };
}

const environment = {
  getDatabaseStatementTimeoutMs: () => 30_000,
} as unknown as EnvironmentService;

describe('MigrationService', () => {
  it('pins migrations to one connection and commits once they succeed', async () => {
    const { db, connection } = buildDb();
    const migrateToLatest = jest
      .fn()
      .mockResolvedValue({ error: undefined, results: [] });
    const service = new TestMigrationService(db, environment, migrateToLatest);

    await service.migrateToLatest();

    expect(migrateToLatest).toHaveBeenCalledTimes(1);
    expect(service.migratorDb).toBe(connection);
    expect(service.clearedOn).toEqual([connection]);
    expect(service.statements).toEqual(['begin', 'commit']);
    expect(service.statementTimeouts).toEqual([900_000, 30_000]);
  });

  it('rolls the transaction back and exits when a migration fails', async () => {
    const { db } = buildDb();
    const resultSet = {
      error: new Error('boom'),
      results: [{ migrationName: 'baseline', status: 'Error' }],
    };
    const migrateToLatest = jest.fn().mockResolvedValue(resultSet);
    const exit = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    try {
      const service = new TestMigrationService(
        db,
        environment,
        migrateToLatest,
      );

      await service.migrateToLatest();

      expect(service.statements).toEqual(['begin', 'rollback']);
      expect(exit).toHaveBeenCalledWith(1);
      expect(service.statementTimeouts).toEqual([900_000, 30_000]);
    } finally {
      exit.mockRestore();
    }
  });

  it('rolls the transaction back and rethrows when the migrator throws', async () => {
    const { db } = buildDb();
    const migrateToLatest = jest.fn().mockRejectedValue(new Error('boom'));
    const service = new TestMigrationService(db, environment, migrateToLatest);

    await expect(service.migrateToLatest()).rejects.toThrow('boom');
    expect(service.statements).toEqual(['begin', 'rollback']);
    expect(service.statementTimeouts).toEqual([900_000, 30_000]);
  });

  // Regression: the migrator runs with `disableTransactions: true`, so it calls
  // `db.connection()` itself. Handing it a `Transaction` made that throw
  // "calling the connection method for a Transaction is not supported".
  it('gives the real migrator a db it can open a connection on', async () => {
    const migrationFolder = await fs.mkdtemp(
      path.join(os.tmpdir(), 'akasha-migrations-'),
    );
    const db = new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (it: Kysely<any>) => new PostgresIntrospector(it),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    const logged: unknown[] = [];
    const service = new RealMigratorService(
      db as unknown as ServiceDb,
      environment,
      migrationFolder,
    );
    jest
      .spyOn(service['logger'], 'error')
      .mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });

    try {
      await service.migrateToLatest();

      expect(logged).toEqual([]);
    } finally {
      await db.destroy();
      await fs.rm(migrationFolder, { recursive: true, force: true });
    }
  });
});

class TestMigrationService extends MigrationService {
  migratorDb: unknown;
  clearedOn: unknown[] = [];
  statements: string[] = [];
  statementTimeouts: number[] = [];

  constructor(
    db: ServiceDb,
    environmentService: EnvironmentService,
    private readonly migrate: jest.Mock,
  ) {
    super(db, environmentService);
  }

  async clearPreBaselineHistory(db: ServiceDb): Promise<void> {
    this.clearedOn.push(db);
  }

  protected createMigrator(db: unknown) {
    this.migratorDb = db;
    return { migrateToLatest: this.migrate } as never;
  }

  protected async execRaw(_db: ServiceDb, statement: string): Promise<void> {
    this.statements.push(statement);
  }

  protected async setStatementTimeout(
    _db: ServiceDb,
    timeoutMs: number,
  ): Promise<void> {
    this.statementTimeouts.push(timeoutMs);
  }
}

class RealMigratorService extends MigrationService {
  constructor(
    db: ServiceDb,
    environmentService: EnvironmentService,
    private readonly folder: string,
  ) {
    super(db, environmentService);
  }

  protected migrationFolder(): string {
    return this.folder;
  }
}
