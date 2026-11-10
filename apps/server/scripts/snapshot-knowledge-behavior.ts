/**
 * Snapshot observable knowledge behavior so a refactor can be diffed:
 * - retrieval: final chunk ids/origins per real user question (default mode)
 * - graph view: per-space node/edge counts by type and reason, plus insights
 *
 * Read-only. Uses a minimal Nest context (no queue workers, schedulers, HTTP or
 * Redis) so it never competes with a running dev server.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register --transpile-only \
 *     scripts/snapshot-knowledge-behavior.ts --out /tmp/before.json
 *   node scripts/snapshot-knowledge-behavior.ts --diff a.json b.json  (see diff mode below)
 */
import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { Global, Module } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { CacheModule } from '@nestjs/cache-manager';
import { NestFactory } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { sql } from 'kysely';
import { QueueName } from '../src/integrations/queue/constants/queue.constants';
import { KyselyDB } from '../src/database/types/kysely.types';
import { DatabaseModule } from '../src/database/database.module';
import { EnvironmentModule } from '../src/integrations/environment/environment.module';
import { loadRuntimeConfiguration } from '../src/integrations/environment/consul-config.loader';
import { SpaceAuthorizationService } from '../src/core/space/services/space-authorization.service';
import { AiConfigSecretService } from '../src/features/llm-wiki/services/ai-config-secret.service';
import { AiModelConfigService } from '../src/features/llm-wiki/services/ai-model-config.service';
import { ConfiguredKnowledgeEmbeddingProvider } from '../src/features/llm-wiki/services/knowledge-embedding-provider.service';
import { KnowledgeRetrievalRankerService } from '../src/features/llm-wiki/services/knowledge-retrieval-ranker.service';
import { KnowledgeSourceAuthorizationService } from '../src/features/llm-wiki/services/knowledge-source-authorization.service';
import { KnowledgeRetrievalService } from '../src/features/llm-wiki/services/knowledge-retrieval.service';
import { KnowledgeGraphService } from '../src/features/llm-wiki/services/knowledge-graph.service';

const inertQueue = {
  add: () => {
    throw new Error('snapshot-knowledge-behavior must not enqueue jobs');
  },
};
@Global()
@Module({
  providers: Object.values(QueueName).map((name) => ({
    provide: getQueueToken(name),
    useValue: inertQueue,
  })),
  exports: Object.values(QueueName).map((name) => getQueueToken(name)),
})
class InertQueueModule {}

@Module({
  imports: [
    EnvironmentModule,
    InertQueueModule,
    DatabaseModule,
    EventEmitterModule.forRoot(),
    CacheModule.register({ isGlobal: true }),
  ],
  providers: [
    SpaceAuthorizationService,
    AiConfigSecretService,
    AiModelConfigService,
    ConfiguredKnowledgeEmbeddingProvider,
    KnowledgeRetrievalRankerService,
    KnowledgeSourceAuthorizationService,
    KnowledgeRetrievalService,
    KnowledgeGraphService,
  ],
})
class SnapshotModule {}

const arg = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

async function snapshot(out: string): Promise<void> {
  await loadRuntimeConfiguration();
  const app = await NestFactory.createApplicationContext(SnapshotModule, {
    logger: ['error', 'warn'],
  });
  try {
    const db = app.get<KyselyDB>(KYSELY_MODULE_CONNECTION_TOKEN());
    const retrieval = app.get(KnowledgeRetrievalService);
    const graphService = app.get(KnowledgeGraphService);
    const { rows: database } = await sql<{
      name: string;
    }>`SELECT current_database() AS name`.execute(db);

    const questions = await sql<{
      query: string;
      userId: string;
      workspaceId: string;
    }>`
      SELECT DISTINCT ON (btrim(content))
        btrim(content) AS query, user_id AS "userId", workspace_id AS "workspaceId"
      FROM ai_chat_messages
      WHERE role = 'user' AND deleted_at IS NULL AND user_id IS NOT NULL
        AND length(btrim(content)) BETWEEN 4 AND 300
      ORDER BY btrim(content), created_at DESC
    `.execute(db);

    const spaces = await db
      .selectFrom('knowledgePages')
      .innerJoin('spaces', 'spaces.id', 'knowledgePages.spaceId')
      .select([
        'knowledgePages.workspaceId',
        'knowledgePages.spaceId',
        'spaces.name',
        'spaces.creatorId',
      ])
      .distinct()
      .where('knowledgePages.staleAt', 'is', null)
      .where('spaces.deletedAt', 'is', null)
      .execute();
    const spaceIdsByWorkspace = new Map<string, string[]>();
    for (const space of spaces) {
      spaceIdsByWorkspace.set(space.workspaceId, [
        ...(spaceIdsByWorkspace.get(space.workspaceId) ?? []),
        space.spaceId,
      ]);
    }

    const retrievalSnapshot: Record<string, unknown> = {};
    for (const question of questions.rows) {
      const spaceIds = spaceIdsByWorkspace.get(question.workspaceId) ?? [];
      if (spaceIds.length === 0) continue;
      const result = await retrieval.retrieve({
        workspaceId: question.workspaceId,
        userId: question.userId,
        query: question.query,
        spaceIds,
      });
      retrievalSnapshot[question.query] = {
        chunks: result.chunks.map(
          (candidate) => `${candidate.origin}:${candidate.chunk.id}`,
        ),
        graph: {
          selected: result.diagnostics.graph.selectedCount,
          edgeCounts: result.diagnostics.graph.edgeCounts,
        },
      };
    }

    const graphSnapshot: Record<string, unknown> = {};
    for (const space of spaces) {
      const graph = await graphService.getSpaceGraph({
        workspaceId: space.workspaceId,
        userId: space.creatorId,
        spaceId: space.spaceId,
      });
      const edgesBy = (key: (edge: (typeof graph.edges)[number]) => string) =>
        graph.edges.reduce<Record<string, number>>((counts, edge) => {
          counts[key(edge)] = (counts[key(edge)] ?? 0) + 1;
          return counts;
        }, {});
      graphSnapshot[`${space.name} (${space.spaceId})`] = {
        nodes: graph.nodes.length,
        edgesByType: edgesBy((edge) => edge.type),
        edgesByOrigin: edgesBy((edge) =>
          edge.id.startsWith('derived:')
            ? 'derived'
            : edge.id.startsWith('contains:')
              ? 'contains'
              : edge.type,
        ),
        isolated: graph.insights.isolatedNodeIds.length,
        bridges: graph.insights.bridgeNodeIds.length,
        communities: graph.insights.communityCount,
      };
    }

    writeFileSync(
      out,
      JSON.stringify(
        {
          database: database[0]?.name,
          retrieval: retrievalSnapshot,
          graph: graphSnapshot,
        },
        null,
        2,
      ),
    );
    console.log(
      `database=${database[0]?.name} questions=${Object.keys(retrievalSnapshot).length} spaces=${Object.keys(graphSnapshot).length} -> ${out}`,
    );
  } finally {
    await app.close();
  }
}

/** Prints every question / space whose snapshot differs between two runs. */
function diff(beforePath: string, afterPath: string): void {
  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(readFileSync(afterPath, 'utf8'));
  for (const section of ['retrieval', 'graph'] as const) {
    const keys = new Set([
      ...Object.keys(before[section]),
      ...Object.keys(after[section]),
    ]);
    let changed = 0;
    for (const key of keys) {
      const left = JSON.stringify(before[section][key]);
      const right = JSON.stringify(after[section][key]);
      if (left === right) continue;
      changed += 1;
      console.log(
        `\n[${section}] ${key}\n  before: ${left}\n  after:  ${right}`,
      );
    }
    console.log(`\n${section}: ${changed}/${keys.size} changed`);
  }
}

const diffIndex = process.argv.indexOf('--diff');
if (diffIndex >= 0) {
  diff(process.argv[diffIndex + 1], process.argv[diffIndex + 2]);
} else {
  snapshot(arg('--out') ?? '/tmp/knowledge-snapshot.json').catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
