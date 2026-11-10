import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Migrator, FileMigrationProvider, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { MIGRATION_STATEMENT_TIMEOUT_MS } from '../database-postgres-options';
import { clearPreBaselineMigrationHistory } from '../prune-migration-history';

type MigrationResultSet = Awaited<ReturnType<Migrator['migrateToLatest']>>;

@Injectable()
export class MigrationService {
  private readonly logger = new Logger(`Database${MigrationService.name}`);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly environmentService: EnvironmentService,
  ) {}

  async clearPreBaselineHistory(db: KyselyDB = this.db): Promise<void> {
    const { cleared, deleted } = await clearPreBaselineMigrationHistory(db, {
      migrationFolder: this.migrationFolder(),
    });
    if (!cleared) return;
    this.logger.log(
      `Cleared ${deleted} pre-baseline migration row(s); the v1.0 baseline will replay over the existing schema`,
    );
  }

  async migrateToLatest(): Promise<void> {
    const { error, results } = await this.db
      .connection()
      .execute(async (connection) => {
        await this.setStatementTimeout(
          connection,
          MIGRATION_STATEMENT_TIMEOUT_MS,
        );
        try {
          return await this.runMigrationTransaction(connection);
        } finally {
          await this.setStatementTimeout(
            connection,
            this.environmentService.getDatabaseStatementTimeoutMs(),
          );
        }
      });

    this.reportMigrationResult({ error, results });
  }

  private async runMigrationTransaction(
    connection: KyselyDB,
  ): Promise<MigrationResultSet> {
    await this.execRaw(connection, 'begin');

    let resultSet: MigrationResultSet;
    try {
      await this.clearPreBaselineHistory(connection);
      resultSet = await this.createMigrator(connection).migrateToLatest();
    } catch (error) {
      await this.rollbackQuietly(connection);
      throw error;
    }

    if (resultSet.error) {
      await this.rollbackQuietly(connection);
      return resultSet;
    }

    await this.execRaw(connection, 'commit');
    return resultSet;
  }

  private async rollbackQuietly(connection: KyselyDB): Promise<void> {
    try {
      await this.execRaw(connection, 'rollback');
    } catch (rollbackError) {
      this.logger.error('Failed to roll back the migration transaction');
      this.logger.error(rollbackError);
    }
  }

  protected async execRaw(db: KyselyDB, statement: string): Promise<void> {
    await sql.raw(statement).execute(db);
  }

  protected migrationFolder(): string {
    return path.join(__dirname, '..', 'migrations');
  }

  protected createMigrator(db: KyselyDB): Migrator {
    return new Migrator({
      db,
      allowUnorderedMigrations: true,
      disableTransactions: true,
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: this.migrationFolder(),
      }),
    });
  }

  protected async setStatementTimeout(
    db: KyselyDB,
    timeoutMs: number,
  ): Promise<void> {
    await sql`select set_config('statement_timeout', ${String(timeoutMs)}, false)`.execute(
      db,
    );
  }

  private reportMigrationResult(
    input: Awaited<ReturnType<Migrator['migrateToLatest']>>,
  ): void {
    const { error, results } = input;
    if (results && results.length === 0) {
      this.logger.log('No pending database migrations');
      return;
    }

    results?.forEach((it) => {
      if (it.status === 'Success') {
        this.logger.log(
          `Migration "${it.migrationName}" executed successfully`,
        );
      } else if (it.status === 'Error') {
        this.logger.error(`Failed to execute migration "${it.migrationName}"`);
      }
    });

    if (error) {
      this.logger.error('Failed to run database migration. Exiting program.');
      this.logger.error(error);
      process.exit(1);
    }
  }
}
