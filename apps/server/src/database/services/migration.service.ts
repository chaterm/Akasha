import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Migrator, FileMigrationProvider, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { MIGRATION_STATEMENT_TIMEOUT_MS } from '../database-postgres-options';

@Injectable()
export class MigrationService {
  private readonly logger = new Logger(`Database${MigrationService.name}`);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly environmentService: EnvironmentService,
  ) {}

  async migrateToLatest(): Promise<void> {
    const { error, results } = await this.db
      .connection()
      .execute(async (db) => {
        await this.setStatementTimeout(db, MIGRATION_STATEMENT_TIMEOUT_MS);
        try {
          return await this.createMigrator(db).migrateToLatest();
        } finally {
          await this.setStatementTimeout(
            db,
            this.environmentService.getDatabaseStatementTimeoutMs(),
          );
        }
      });

    this.reportMigrationResult({ error, results });
  }

  protected createMigrator(db: KyselyDB): Migrator {
    return new Migrator({
      db,
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: path.join(__dirname, '..', 'migrations'),
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
