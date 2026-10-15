import {
  DatabaseEnvironmentSnapshot,
  DatabaseRequirementsError,
  DatabaseRequirementsService,
  DatabaseSchemaSnapshot,
  evaluateDatabaseEnvironment,
  evaluateDatabaseSchema,
} from './database-requirements.service';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from 'kysely';

const cloudEnvironment: DatabaseEnvironmentSnapshot = {
  serverVersionNum: 180004,
  serverVersion: '18.4',
  encoding: 'UTF8',
  ctype: 'C',
  sharedPreloadLibraries: ['pg_jieba'],
  availableExtensions: ['vector', 'pg_trgm', 'pg_jieba'],
};

const migratedSchema: DatabaseSchemaSnapshot = {
  installedExtensions: ['plpgsql', 'vector', 'pg_trgm', 'pg_jieba'],
  textSearchConfigs: ['jiebacfg', 'jiebaqry'],
  hasZhSearchColumn: true,
  hasZhSearchTrigger: true,
  hasZhTsqueryFunction: true,
  pendingZhSearchRows: 0,
};

describe('evaluateDatabaseEnvironment', () => {
  it('accepts the cloud database configuration', () => {
    expect(evaluateDatabaseEnvironment(cloudEnvironment)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('rejects PostgreSQL older than 18', () => {
    const { errors } = evaluateDatabaseEnvironment({
      ...cloudEnvironment,
      serverVersionNum: 170005,
      serverVersion: '17.5',
    });
    expect(errors).toEqual([expect.stringContaining('PostgreSQL 17.5')]);
  });

  it('rejects a server without pg_jieba available', () => {
    const { errors } = evaluateDatabaseEnvironment({
      ...cloudEnvironment,
      availableExtensions: ['vector', 'pg_trgm'],
      sharedPreloadLibraries: [],
    });
    expect(errors).toEqual([
      expect.stringContaining('not available on the server: pg_jieba'),
      expect.stringContaining('shared_preload_libraries must include pg_jieba'),
    ]);
  });

  it('rejects a server that does not preload pg_jieba', () => {
    const { errors } = evaluateDatabaseEnvironment({
      ...cloudEnvironment,
      sharedPreloadLibraries: ['pg_stat_statements'],
    });
    expect(errors).toEqual([
      expect.stringContaining("current: 'pg_stat_statements'"),
    ]);
  });

  it('rejects non-UTF8 databases', () => {
    const { errors } = evaluateDatabaseEnvironment({
      ...cloudEnvironment,
      encoding: 'SQL_ASCII',
    });
    expect(errors).toEqual([expect.stringContaining('SQL_ASCII')]);
  });

  it('only warns when the locale differs from production', () => {
    expect(
      evaluateDatabaseEnvironment({ ...cloudEnvironment, ctype: 'en_US.utf8' }),
    ).toEqual({
      errors: [],
      warnings: [expect.stringContaining('LC_CTYPE is en_US.utf8')],
    });
  });
});

describe('evaluateDatabaseSchema', () => {
  it('accepts a migrated and backfilled schema', () => {
    expect(evaluateDatabaseSchema(migratedSchema)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('rejects an unmigrated schema', () => {
    const { errors } = evaluateDatabaseSchema({
      installedExtensions: ['plpgsql', 'vector', 'pg_trgm'],
      textSearchConfigs: [],
      hasZhSearchColumn: false,
      hasZhSearchTrigger: false,
      hasZhTsqueryFunction: false,
      pendingZhSearchRows: null,
    });
    expect(errors).toEqual([
      expect.stringContaining('extensions not installed: pg_jieba'),
      expect.stringContaining('jiebacfg, jiebaqry'),
      expect.stringContaining(
        'knowledge_chunks.search_tsv_zh, trigger knowledge_chunks_search_tsv_zh_refresh, functions knowledge_zh_tsquery/knowledge_zh_query_terms',
      ),
    ]);
  });

  it('warns while the Chinese search backfill is pending', () => {
    expect(
      evaluateDatabaseSchema({ ...migratedSchema, pendingZhSearchRows: 12 }),
    ).toEqual({
      errors: [],
      warnings: [expect.stringContaining('12 knowledge chunks')],
    });
    expect(
      evaluateDatabaseSchema({ ...migratedSchema, pendingZhSearchRows: 10001 })
        .warnings,
    ).toEqual([expect.stringContaining('more than 10000')]);
  });
});

describe('DatabaseRequirementsService', () => {
  function createService(rows: Record<string, unknown>[]) {
    const connection = {
      executeQuery: async () => ({ rows: [rows.shift()] }) as QueryResult<any>,
      streamQuery: () => {
        throw new Error('not supported');
      },
    };
    const db = new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => ({
          init: async () => {},
          acquireConnection: async () => connection,
          beginTransaction: async () => {},
          commitTransaction: async () => {},
          rollbackTransaction: async () => {},
          releaseConnection: async () => {},
          destroy: async () => {},
        }),
        createIntrospector: (instance) => new PostgresIntrospector(instance),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    return new DatabaseRequirementsService(db as unknown as KyselyDB);
  }

  it('throws a DatabaseRequirementsError listing every failed requirement', async () => {
    const service = createService([
      {
        serverVersionNum: '170005',
        serverVersion: '17.5',
        encoding: 'UTF8',
        ctype: 'C',
        sharedPreloadLibraries: '',
        availableExtensions: ['vector', 'pg_trgm'],
      },
    ]);

    const error = await service.assertEnvironment().catch((err) => err);

    expect(error).toBeInstanceOf(DatabaseRequirementsError);
    expect(error.errors).toHaveLength(3);
    expect(error.message).toContain('PostgreSQL 17.5');
  });

  it('parses quoted and suffixed shared_preload_libraries entries', async () => {
    const service = createService([
      {
        serverVersionNum: '180004',
        serverVersion: '18.4',
        encoding: 'UTF8',
        ctype: 'C',
        sharedPreloadLibraries: 'pg_stat_statements, "pg_jieba.so"',
        availableExtensions: ['vector', 'pg_trgm', 'pg_jieba'],
      },
    ]);

    await expect(service.assertEnvironment()).resolves.toBeUndefined();
  });
});
