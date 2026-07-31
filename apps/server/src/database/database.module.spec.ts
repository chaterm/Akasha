import {
  buildDatabasePostgresOptions,
  buildMigrationPostgresOptions,
  DatabaseModule,
} from './database.module';
import { EnvironmentService } from '../integrations/environment/environment.service';

describe('DatabaseModule lifecycle', () => {
  it('initializes the database before provider module-init hooks can query it', () => {
    const lifecycle = DatabaseModule.prototype as unknown as Record<
      string,
      unknown
    >;

    expect(typeof lifecycle.onModuleInit).toBe('function');
    expect(lifecycle.onApplicationBootstrap).toBeUndefined();
  });

  it('configures the online pool and statement timeout on every connection', () => {
    const options = buildDatabasePostgresOptions({
      getDatabaseMaxPool: () => 25,
      getDatabaseStatementTimeoutMs: () => 30_000,
    } as unknown as EnvironmentService);

    expect(options.max).toBe(25);
    expect(options.connection).toEqual({ statement_timeout: 30_000 });
  });

  it('keeps migrations outside the online statement timeout', () => {
    expect(buildMigrationPostgresOptions().connection).toEqual({
      statement_timeout: 900_000,
    });
  });
});
