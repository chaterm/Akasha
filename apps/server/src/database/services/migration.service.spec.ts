import { EnvironmentService } from '../../integrations/environment/environment.service';
import { MigrationService } from './migration.service';

describe('MigrationService statement timeout', () => {
  it('pins migrations to one connection and restores the online timeout', async () => {
    const connectionDb = {};
    const db = {
      connection: () => ({
        execute: (callback: (connection: unknown) => Promise<unknown>) =>
          callback(connectionDb),
      }),
    };
    const environment = {
      getDatabaseStatementTimeoutMs: () => 30_000,
    };
    const migrateToLatest = jest.fn().mockResolvedValue({
      error: undefined,
      results: [],
    });
    const service = new TestMigrationService(
      db as never,
      environment as unknown as EnvironmentService,
      migrateToLatest,
    );

    await service.migrateToLatest();

    expect(migrateToLatest).toHaveBeenCalledTimes(1);
    expect(service.migratorDb).toBe(connectionDb);
    expect(service.statementTimeouts).toEqual([900_000, 30_000]);
  });
});

class TestMigrationService extends MigrationService {
  migratorDb: unknown;
  statementTimeouts: number[] = [];

  constructor(
    db: ConstructorParameters<typeof MigrationService>[0],
    environment: EnvironmentService,
    private readonly migrate: jest.Mock,
  ) {
    super(db, environment);
  }

  protected createMigrator(db: unknown) {
    this.migratorDb = db;
    return { migrateToLatest: this.migrate } as never;
  }

  protected async setStatementTimeout(
    _db: ConstructorParameters<typeof MigrationService>[0],
    timeoutMs: number,
  ): Promise<void> {
    this.statementTimeouts.push(timeoutMs);
  }
}
