import {
  IsInt,
  IsIn,
  IsNotEmpty,
  IsNotIn,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';
import { plainToInstance, Type } from 'class-transformer';
import { IsISO6391 } from '../../common/validators/is-iso6391';

export class EnvironmentVariables {
  @IsNotEmpty()
  @IsUrl(
    {
      protocols: ['postgres', 'postgresql'],
      require_tld: false,
      allow_underscores: true,
    },
    { message: 'DATABASE_URL must be a valid postgres connection string' },
  )
  DATABASE_URL: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  DATABASE_MAX_POOL: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5_000)
  @Max(120_000)
  DATABASE_STATEMENT_TIMEOUT_MS: number;

  @IsNotEmpty()
  @IsUrl(
    {
      protocols: ['redis', 'rediss'],
      require_tld: false,
      allow_underscores: true,
    },
    { message: 'REDIS_URL must be a valid redis connection string' },
  )
  REDIS_URL: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  APP_URL: string;

  @IsNotEmpty()
  @MinLength(32)
  @IsNotIn(['REPLACE_WITH_LONG_SECRET'])
  APP_SECRET: string;

  @IsOptional()
  @IsIn(['smtp', 'postmark'])
  MAIL_DRIVER: string;

  @IsOptional()
  @IsIn(['local', 's3', 'azure'])
  STORAGE_DRIVER: string;

  @IsOptional()
  @ValidateIf((obj) => obj.COLLAB_URL != '' && obj.COLLAB_URL != null)
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  COLLAB_URL: string;

  @IsOptional()
  CLOUD: boolean;

  @IsOptional()
  @IsUrl(
    { protocols: [], require_tld: true },
    {
      message:
        'SUBDOMAIN_HOST must be a valid FQDN domain without the http protocol. e.g example.com',
    },
  )
  @ValidateIf((obj) => obj.CLOUD === 'true'.toLowerCase())
  SUBDOMAIN_HOST: string;

  @IsOptional()
  @IsIn(['database', 'typesense'])
  @IsString()
  SEARCH_DRIVER: string;

  @IsOptional()
  @IsUrl(
    {
      protocols: ['http', 'https'],
      require_tld: false,
      allow_underscores: true,
    },
    {
      message:
        'TYPESENSE_URL must be a valid typesense url e.g http://localhost:8108',
    },
  )
  @ValidateIf((obj) => obj.SEARCH_DRIVER === 'typesense')
  TYPESENSE_URL: string;

  @ValidateIf((obj) => obj.SEARCH_DRIVER === 'typesense')
  @IsNotEmpty()
  @IsString()
  TYPESENSE_API_KEY: string;

  @IsOptional()
  @ValidateIf((obj) => obj.SEARCH_DRIVER === 'typesense')
  @IsISO6391()
  @IsString()
  TYPESENSE_LOCALE: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(131_072)
  KNOWLEDGE_COMPILER_MAX_OUTPUT_TOKENS: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(131_072)
  KNOWLEDGE_IMAGE_MERGE_MAX_OUTPUT_TOKENS: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10_000)
  @Max(600_000)
  KNOWLEDGE_COMPILER_TIMEOUT_MS: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10_000)
  @Max(600_000)
  KNOWLEDGE_IMAGE_TIMEOUT_MS: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(300_000)
  @Max(900_000)
  KNOWLEDGE_PAGE_DEADLINE_MS: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(60_000)
  @Max(600_000)
  KNOWLEDGE_AGGREGATE_DEADLINE_MS: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(120_000)
  @Max(300_000)
  KNOWLEDGE_IMAGE_JOB_DEADLINE_MS: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  KNOWLEDGE_SPACE_CONCURRENCY: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  KNOWLEDGE_IMAGE_CONCURRENCY: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  KNOWLEDGE_SPACE_SLICE_MAX_PAGES: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(60_000)
  @Max(900_000)
  KNOWLEDGE_SPACE_SLICE_MAX_MS: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10_000)
  @Max(60_000)
  KNOWLEDGE_SPACE_HEARTBEAT_MS: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(120_000)
  @Max(600_000)
  KNOWLEDGE_SPACE_LEASE_TTL_MS: number;

  @IsOptional()
  @IsIn(['postgres', 'clickhouse'])
  @IsString()
  EVENT_STORE_DRIVER: string;

  @ValidateIf((obj) => obj.EVENT_STORE_DRIVER === 'clickhouse')
  @IsNotEmpty()
  @IsUrl(
    { protocols: ['http', 'https'], require_tld: false },
    {
      message:
        'CLICKHOUSE_URL must be a valid URL e.g http://user:password@localhost:8123/akasha',
    },
  )
  CLICKHOUSE_URL: string;
}

export function validate(config: Record<string, any>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config);

  const errors = validateSync(validatedConfig);

  if (errors.length > 0) {
    console.error(
      'The Environment variables has failed the following validations:',
    );

    errors.map((error) => {
      console.error(JSON.stringify(error.constraints));
    });

    console.error(
      'Please fix the environment variables and try again. Exiting program...',
    );
    process.exit(1);
  }

  const heartbeat = validatedConfig.KNOWLEDGE_SPACE_HEARTBEAT_MS ?? 30_000;
  const executionLeaseTtl =
    validatedConfig.KNOWLEDGE_SPACE_LEASE_TTL_MS ?? 180_000;
  if (heartbeat >= executionLeaseTtl) {
    console.error(
      'KNOWLEDGE_SPACE_HEARTBEAT_MS must be less than KNOWLEDGE_SPACE_LEASE_TTL_MS.',
    );
    process.exit(1);
  }

  const databaseMaxPool = validatedConfig.DATABASE_MAX_POOL ?? 25;
  const spaceConcurrency = validatedConfig.KNOWLEDGE_SPACE_CONCURRENCY ?? 10;
  const imageConcurrency = validatedConfig.KNOWLEDGE_IMAGE_CONCURRENCY ?? 5;
  if (databaseMaxPool < spaceConcurrency + imageConcurrency + 10) {
    console.error(
      'DATABASE_MAX_POOL must be at least KNOWLEDGE_SPACE_CONCURRENCY + KNOWLEDGE_IMAGE_CONCURRENCY + 10.',
    );
    process.exit(1);
  }

  return validatedConfig;
}
