import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';

// Components the server needs from PostgreSQL. Keep in sync with
// docker/postgres/Dockerfile and the cloud database configuration.
export const MIN_SERVER_VERSION_NUM = 180000;
export const REQUIRED_EXTENSIONS = ['vector', 'pg_trgm', 'pg_jieba'] as const;
export const REQUIRED_PRELOAD_LIBRARIES = ['pg_jieba'] as const;
export const REQUIRED_TEXT_SEARCH_CONFIGS = ['jiebacfg', 'jiebaqry'] as const;
const EXPECTED_CTYPES = ['C', 'C.UTF-8', 'C.utf8'];
const PENDING_ROWS_PROBE_LIMIT = 10000;

export type DatabaseEnvironmentSnapshot = {
  serverVersionNum: number;
  serverVersion: string;
  encoding: string;
  ctype: string;
  sharedPreloadLibraries: string[];
  availableExtensions: string[];
};

export type DatabaseSchemaSnapshot = {
  installedExtensions: string[];
  textSearchConfigs: string[];
  hasZhSearchColumn: boolean;
  hasZhSearchTrigger: boolean;
  hasZhTsqueryFunction: boolean;
  pendingZhSearchRows: number | null;
};

export type RequirementReport = { errors: string[]; warnings: string[] };

export class DatabaseRequirementsError extends Error {
  constructor(readonly errors: string[]) {
    super(
      `Database does not meet the server requirements:\n- ${errors.join('\n- ')}`,
    );
    this.name = 'DatabaseRequirementsError';
  }
}

export function evaluateDatabaseEnvironment(
  snapshot: DatabaseEnvironmentSnapshot,
): RequirementReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (snapshot.serverVersionNum < MIN_SERVER_VERSION_NUM) {
    errors.push(
      `PostgreSQL ${snapshot.serverVersion} is not supported; 18 or later is required`,
    );
  }
  if (snapshot.encoding !== 'UTF8') {
    errors.push(`database encoding is ${snapshot.encoding}; UTF8 is required`);
  }
  const missingAvailable = REQUIRED_EXTENSIONS.filter(
    (name) => !snapshot.availableExtensions.includes(name),
  );
  if (missingAvailable.length > 0) {
    errors.push(
      `extensions not available on the server: ${missingAvailable.join(', ')}`,
    );
  }
  const missingPreload = REQUIRED_PRELOAD_LIBRARIES.filter(
    (name) => !snapshot.sharedPreloadLibraries.includes(name),
  );
  if (missingPreload.length > 0) {
    // Without preloading, every connection loads its own ~110 MB jieba
    // dictionary on first use (≈4.5 GB for a 40-connection pool).
    errors.push(
      `shared_preload_libraries must include ${missingPreload.join(', ')} ` +
        `(current: '${snapshot.sharedPreloadLibraries.join(',')}')`,
    );
  }
  if (!EXPECTED_CTYPES.includes(snapshot.ctype)) {
    warnings.push(
      `database LC_CTYPE is ${snapshot.ctype}; production uses C, so text ` +
        `search behaviour may differ from production`,
    );
  }

  return { errors, warnings };
}

export function evaluateDatabaseSchema(
  snapshot: DatabaseSchemaSnapshot,
): RequirementReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const missingInstalled = REQUIRED_EXTENSIONS.filter(
    (name) => !snapshot.installedExtensions.includes(name),
  );
  if (missingInstalled.length > 0) {
    errors.push(
      `extensions not installed: ${missingInstalled.join(', ')} (run migrations)`,
    );
  }
  const missingConfigs = REQUIRED_TEXT_SEARCH_CONFIGS.filter(
    (name) => !snapshot.textSearchConfigs.includes(name),
  );
  if (missingConfigs.length > 0) {
    errors.push(
      `text search configurations missing: ${missingConfigs.join(', ')}`,
    );
  }
  const missingObjects = [
    !snapshot.hasZhSearchColumn && 'knowledge_chunks.search_tsv_zh',
    !snapshot.hasZhSearchTrigger &&
      'trigger knowledge_chunks_search_tsv_zh_refresh',
    !snapshot.hasZhTsqueryFunction &&
      'functions knowledge_zh_tsquery/knowledge_zh_query_terms',
  ].filter((item): item is string => Boolean(item));
  if (missingObjects.length > 0) {
    errors.push(
      `Chinese search schema missing: ${missingObjects.join(', ')} (run migrations)`,
    );
  }
  if (snapshot.pendingZhSearchRows && snapshot.pendingZhSearchRows > 0) {
    const count =
      snapshot.pendingZhSearchRows > PENDING_ROWS_PROBE_LIMIT
        ? `more than ${PENDING_ROWS_PROBE_LIMIT}`
        : String(snapshot.pendingZhSearchRows);
    warnings.push(
      `${count} knowledge chunks have no Chinese search ` +
        `index yet; run the backfill-knowledge-chunk-zh-search script`,
    );
  }

  return { errors, warnings };
}

@Injectable()
export class DatabaseRequirementsService {
  private readonly logger = new Logger(DatabaseRequirementsService.name);

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  // Before migrations: the server itself must provide every component the
  // migrations depend on, so a missing extension fails here with a clear
  // message instead of halfway through a migration.
  async assertEnvironment(): Promise<void> {
    this.apply(evaluateDatabaseEnvironment(await this.readEnvironment()));
  }

  // After migrations: the schema objects the running code relies on exist.
  async assertSchema(): Promise<void> {
    this.apply(evaluateDatabaseSchema(await this.readSchema()));
  }

  private apply(report: RequirementReport): void {
    for (const warning of report.warnings) this.logger.warn(warning);
    if (report.errors.length > 0) {
      throw new DatabaseRequirementsError(report.errors);
    }
  }

  private async readEnvironment(): Promise<DatabaseEnvironmentSnapshot> {
    const result = await sql<{
      serverVersionNum: string;
      serverVersion: string;
      encoding: string;
      ctype: string;
      sharedPreloadLibraries: string;
      availableExtensions: string[];
    }>`
      SELECT
        current_setting('server_version_num') AS "serverVersionNum",
        current_setting('server_version') AS "serverVersion",
        pg_encoding_to_char(d.encoding) AS encoding,
        d.datctype AS ctype,
        current_setting('shared_preload_libraries') AS "sharedPreloadLibraries",
        ARRAY(
          SELECT name::text FROM pg_available_extensions
          WHERE name = ANY(${[...REQUIRED_EXTENSIONS]}::text[])
        ) AS "availableExtensions"
      FROM pg_database d
      WHERE d.datname = current_database()
    `.execute(this.db);
    const row = result.rows[0];
    return {
      serverVersionNum: Number(row.serverVersionNum),
      serverVersion: row.serverVersion,
      encoding: row.encoding,
      ctype: row.ctype,
      sharedPreloadLibraries: row.sharedPreloadLibraries
        .split(',')
        .map((name) => name.trim().replace(/^"|"$/g, '').replace(/\.so$/, ''))
        .filter(Boolean),
      availableExtensions: row.availableExtensions,
    };
  }

  private async readSchema(): Promise<DatabaseSchemaSnapshot> {
    const result = await sql<{
      installedExtensions: string[];
      textSearchConfigs: string[];
      hasZhSearchColumn: boolean;
      hasZhSearchTrigger: boolean;
      hasZhTsqueryFunction: boolean;
    }>`
      SELECT
        ARRAY(SELECT extname::text FROM pg_extension) AS "installedExtensions",
        ARRAY(
          SELECT cfgname::text FROM pg_ts_config
          WHERE cfgname = ANY(${[...REQUIRED_TEXT_SEARCH_CONFIGS]}::text[])
        ) AS "textSearchConfigs",
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = COALESCE(current_schema(), 'public')
            AND table_name = 'knowledge_chunks'
            AND column_name = 'search_tsv_zh'
        ) AS "hasZhSearchColumn",
        EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'knowledge_chunks_search_tsv_zh_refresh'
            AND NOT tgisinternal
        ) AS "hasZhSearchTrigger",
        EXISTS (
          SELECT 1 FROM pg_proc WHERE proname = 'knowledge_zh_tsquery'
        )
        AND EXISTS (
          SELECT 1 FROM pg_proc WHERE proname = 'knowledge_zh_query_terms'
        ) AS "hasZhTsqueryFunction"
    `.execute(this.db);
    const row = result.rows[0];

    let pendingZhSearchRows: number | null = null;
    if (row.hasZhSearchColumn) {
      // Bounded probe: only whether some rows are pending matters at startup,
      // and an exact count over a large table would slow every boot.
      const pending = await sql<{ count: number }>`
        SELECT count(*)::int AS count FROM (
          SELECT 1 FROM knowledge_chunks WHERE search_tsv_zh IS NULL
          LIMIT ${PENDING_ROWS_PROBE_LIMIT + 1}
        ) pending
      `.execute(this.db);
      pendingZhSearchRows = Number(pending.rows[0]?.count ?? 0);
    }

    return { ...row, pendingZhSearchRows };
  }
}
