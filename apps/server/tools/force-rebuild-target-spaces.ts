import 'dotenv/config';
import { Queue } from 'bullmq';
import { CamelCasePlugin, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres from 'postgres';
import { KyselyDB } from '../src/database/types/kysely.types';
import { KnowledgeCompilationRepo } from '../src/database/repos/llm-wiki/knowledge-compilation.repo';
import { KnowledgeImageExtractionRepo } from '../src/database/repos/llm-wiki/knowledge-image-extraction.repo';
import { KnowledgeSpaceCompilationRepo } from '../src/database/repos/llm-wiki/knowledge-space-compilation.repo';
import { normalizePostgresUrl, parseRedisUrl } from '../src/common/helpers';
import {
  DEFAULT_KNOWLEDGE_COMPILER_VERSION,
  DEFAULT_KNOWLEDGE_PROMPT_VERSION,
} from '../src/ee/llm-wiki/llm-wiki.constants';
import { KnowledgeSpaceCompilationService } from '../src/ee/llm-wiki/services/knowledge-space-compilation.service';
import { KnowledgeSpaceResetService } from '../src/ee/llm-wiki/services/knowledge-space-reset.service';
import { QueueName } from '../src/integrations/queue/constants';

const targets = [
  {
    workspaceId: '019ea69a-1ddd-7666-87e7-60002c129717',
    spaceId: '019fc597-7837-706f-a58f-5ff18dabf89f',
    confirmationSpaceName: '多空间编译2',
  },
  {
    workspaceId: '019ea69a-1ddd-7666-87e7-60002c129717',
    spaceId: '019fc597-783a-7b85-babd-b6b18a642fb3',
    confirmationSpaceName: '多空间编译3',
  },
  {
    workspaceId: '019ea69a-1ddd-7666-87e7-60002c129717',
    spaceId: '019fc597-783d-7f64-a5a1-ca806a1a8aac',
    confirmationSpaceName: '多空间编译4',
  },
  {
    workspaceId: '019ea69a-1ddd-7666-87e7-60002c129717',
    spaceId: '019fc597-7840-79f4-b12b-681500726013',
    confirmationSpaceName: '多空间编译5',
  },
  {
    workspaceId: '019ea69a-1ddd-7666-87e7-60002c129717',
    spaceId: '019fc597-7844-7175-94d1-6b9ddb4df004',
    confirmationSpaceName: '多空间编译6',
  },
  {
    workspaceId: '019ea69a-1ddd-7666-87e7-60002c129717',
    spaceId: '019fc597-7847-72d1-829b-de6fc1e94fd6',
    confirmationSpaceName: '多空间编译7',
  },
  {
    workspaceId: '019ea69a-1ddd-7666-87e7-60002c129717',
    spaceId: '019fc597-784a-7b2b-9701-0956045959da',
    confirmationSpaceName: '多空间编译8',
  },
  {
    workspaceId: '019ea69a-1ddd-7666-87e7-60002c129717',
    spaceId: '019fc597-784d-7b3f-98c3-e4dfb3a62cf7',
    confirmationSpaceName: '多空间编译9',
  },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function main() {
  const databaseUrl = normalizePostgresUrl(requireEnv('DATABASE_URL'));
  const redisConfig = parseRedisUrl(requireEnv('REDIS_URL'));
  const sql = postgres(databaseUrl, {
    max: 5,
    connection: {
      statement_timeout: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? 30_000),
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
  });
  const db = new Kysely({
    dialect: new PostgresJSDialect({ postgres: sql }),
    plugins: [new CamelCasePlugin()],
  }) as KyselyDB;
  const spaceQueue = new Queue(QueueName.KNOWLEDGE_SPACE_QUEUE, {
    connection: redisConfig,
  });
  const imageQueue = new Queue(QueueName.KNOWLEDGE_IMAGE_QUEUE, {
    connection: redisConfig,
  });
  try {
    const runRepo = new KnowledgeSpaceCompilationRepo(db);
    const compilation = new KnowledgeSpaceCompilationService(
      spaceQueue,
      imageQueue,
      runRepo,
      new KnowledgeCompilationRepo(db),
      new KnowledgeImageExtractionRepo(db),
      {} as never,
      {} as never,
    );
    const reset = new KnowledgeSpaceResetService(
      spaceQueue,
      imageQueue,
      runRepo,
      compilation,
    );
    for (const target of targets) {
      const result = await reset.forceRebuild(target);
      process.stdout.write(
        JSON.stringify({
          spaceName: target.confirmationSpaceName,
          spaceId: target.spaceId,
          runId: result.run.id,
          knowledgeGeneration: result.generation,
          mode: result.run.mode,
          status: result.run.status,
          phase: result.run.phase,
        }) + '\n',
      );
    }
  } finally {
    await spaceQueue.close();
    await imageQueue.close();
    await db.destroy();
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
