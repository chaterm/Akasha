import * as path from 'path';
import { promises as fs } from 'fs';
import { Kysely, Migrator, FileMigrationProvider } from 'kysely';
import { run } from 'kysely-migration-cli';
import * as dotenv from 'dotenv';
import { envPath, normalizePostgresUrl } from '../common/helpers';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import { buildMigrationPostgresOptions } from './database-postgres-options';
import {
  clearPreBaselineMigrationHistory,
  readMigrationNamesOnDisk,
} from './prune-migration-history';

dotenv.config({ path: envPath });

const migrationFolder = path.join(__dirname, './migrations');

const db = new Kysely<any>({
  dialect: new PostgresJSDialect({
    postgres: postgres(
      normalizePostgresUrl(process.env.DATABASE_URL),
      buildMigrationPostgresOptions(),
    ),
  }),
});

const migrator = new Migrator({
  db,
  allowUnorderedMigrations: true,
  provider: new FileMigrationProvider({
    fs,
    path,
    migrationFolder,
  }),
});


const FORWARD_COMMANDS = new Set(['up', 'latest', 'redo']);

async function preview(): Promise<void> {
  const { cleared, recorded } = await clearPreBaselineMigrationHistory(db, {
    migrationFolder,
    dryRun: true,
  });

  if (cleared) {
    const names = [...(await readMigrationNamesOnDisk(migrationFolder))].sort();
    console.info(
      `Would clear ${recorded} pre-baseline migration row(s), then run ${names.length} migration(s):`,
    );
    names.forEach((name) => console.info(`> Pending: ${name}`));
    return;
  }

  const pending = (await migrator.getMigrations()).filter((it) => !it.executedAt);
  if (pending.length === 0) {
    console.info('No pending database migrations');
    return;
  }

  console.info(`Would run ${pending.length} pending migration(s):`);
  pending.forEach((it) => console.info(`> Pending: ${it.name}`));
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (process.argv.includes('--dry-run') && FORWARD_COMMANDS.has(command)) {
    try {
      await preview();
    } finally {
      await db.destroy();
    }
    return;
  }

  if (FORWARD_COMMANDS.has(command)) {
    try {
      const { cleared, deleted } = await clearPreBaselineMigrationHistory(db, {
        migrationFolder,
      });
      if (cleared) {
        console.info(
          `Cleared ${deleted} pre-baseline migration row(s); the v1.0 baseline will replay over the existing schema.`,
        );
      }
    } catch (error) {
      await db.destroy();
      throw error;
    }
  }

  run(db, migrator, migrationFolder);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
