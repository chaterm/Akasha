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

  it.each(['production', 'development'])(
    'checks database requirements around migrations in %s',
    async (nodeEnv) => {
      const calls: string[] = [];
      const module = new DatabaseModule(
        {} as never,
        { migrateToLatest: async () => calls.push('migrate') } as never,
        { getNodeEnv: () => nodeEnv } as never,
        {
          assertEnvironment: async () => calls.push('environment'),
          assertSchema: async () => calls.push('schema'),
        } as never,
      );
      module.establishConnection = async () => {
        calls.push('connect');
      };

      await module.onModuleInit();

      expect(calls).toEqual(
        nodeEnv === 'production'
          ? ['connect', 'environment', 'migrate', 'schema']
          : ['connect', 'environment', 'schema'],
      );
    },
  );

  it('does not migrate when the database environment check fails', async () => {
    const migrateToLatest = jest.fn();
    const module = new DatabaseModule(
      {} as never,
      { migrateToLatest } as never,
      { getNodeEnv: () => 'production' } as never,
      {
        assertEnvironment: async () => {
          throw new Error('pg_jieba missing');
        },
        assertSchema: jest.fn(),
      } as never,
    );
    module.establishConnection = async () => {};

    await expect(module.onModuleInit()).rejects.toThrow('pg_jieba missing');
    expect(migrateToLatest).not.toHaveBeenCalled();
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
