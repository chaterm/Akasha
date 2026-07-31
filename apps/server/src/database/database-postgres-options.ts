import { EnvironmentService } from '../integrations/environment/environment.service';

export const MIGRATION_STATEMENT_TIMEOUT_MS = 900_000;

export function buildDatabasePostgresOptions(
  environmentService: EnvironmentService,
) {
  return {
    max: environmentService.getDatabaseMaxPool(),
    connection: {
      statement_timeout: environmentService.getDatabaseStatementTimeoutMs(),
    },
    onnotice: () => {},
    types: {
      bigint: {
        to: 20,
        from: [20, 1700],
        serialize: (value: number) => value.toString(),
        parse: (value: string) => Number.parseInt(value),
      },
    },
  };
}

export function buildMigrationPostgresOptions() {
  return {
    connection: {
      statement_timeout: MIGRATION_STATEMENT_TIMEOUT_MS,
    },
  };
}
