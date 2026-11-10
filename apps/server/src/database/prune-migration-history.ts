
import * as path from 'path';
import { promises as fs } from 'fs';
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import * as dotenv from 'dotenv';
import { envPath, normalizePostgresUrl } from '../common/helpers';
import { buildMigrationPostgresOptions } from './database-postgres-options';

const MIGRATION_TABLE = 'kysely_migration';

export interface ClearPreBaselineResult {
  cleared: boolean;
  recorded: number;
  deleted: number;
}

export async function readMigrationNamesOnDisk(
  migrationFolder: string,
): Promise<Set<string>> {
  const entries = await fs.readdir(migrationFolder);
  const names = entries
    .filter((entry) => !entry.endsWith('.d.ts'))
    .filter((entry) =>
      ['.ts', '.js', '.mjs', '.cjs'].includes(path.extname(entry)),
    )
    .map((entry) => path.parse(entry).name);
  return new Set(names);
}

export async function clearPreBaselineMigrationHistory(
  db: Kysely<any>,
  options: { migrationFolder: string; dryRun?: boolean },
): Promise<ClearPreBaselineResult> {
  const tableExists = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ${MIGRATION_TABLE}
    ) AS exists
  `.execute(db);
  if (!tableExists.rows[0]?.exists) {
    return { cleared: false, recorded: 0, deleted: 0 };
  }

  const onDisk = await readMigrationNamesOnDisk(options.migrationFolder);

  if (onDisk.size === 0) {
    throw new Error(
      `Refusing to prune migration history: no migrations found in ${options.migrationFolder}`,
    );
  }

  const recorded = await sql<{ name: string }>`
    SELECT name FROM kysely_migration
  `.execute(db);

  const isPreBaseline =
    recorded.rows.length > 0 &&
    recorded.rows.every((row) => !onDisk.has(row.name));

  if (!isPreBaseline || options.dryRun) {
    return {
      cleared: isPreBaseline,
      recorded: recorded.rows.length,
      deleted: 0,
    };
  }

  const result = await sql`DELETE FROM kysely_migration`.execute(db);

  return {
    cleared: true,
    recorded: recorded.rows.length,
    deleted: Number(result.numAffectedRows ?? recorded.rows.length),
  };
}

async function main(): Promise<void> {
  dotenv.config({ path: envPath });

  const dryRun = process.argv.includes('--dry-run');
  const migrationFolder = path.join(__dirname, './migrations');
  const db = new Kysely<any>({
    dialect: new PostgresJSDialect({
      postgres: postgres(
        normalizePostgresUrl(process.env.DATABASE_URL),
        buildMigrationPostgresOptions(),
      ),
    }),
  });

  try {
    const { cleared, recorded, deleted } =
      await clearPreBaselineMigrationHistory(db, { migrationFolder, dryRun });

    if (!cleared) {
      console.info(
        `Migration history is consistent (${recorded} row(s)); nothing to clear.`,
      );
      return;
    }

    console.info(
      `${dryRun ? 'Would clear' : 'Cleared'} ${
        dryRun ? recorded : deleted
      } pre-baseline migration row(s); the v1.0 baseline will replay over the existing schema.`,
    );
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
