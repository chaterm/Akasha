/**
 * A/B the knowledge graph expansion modes on real user questions.
 *
 * Replays distinct user questions from ai_chat_messages through
 * KnowledgeRetrievalService twice (window_recall vs edge_anchored) and reports
 * which graph chunks each mode selected and which direct hits they displaced,
 * so a reviewer can judge whether graph hits are actually useful.
 *
 * Read-only: retrieval does not write audit rows; nothing else is mutated.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register --transpile-only scripts/eval-graph-expansion.ts \
 *     [--limit 50] [--candidate-limit 20] [--out /tmp/graph-eval.json]
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { Global, Module } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { CacheModule } from '@nestjs/cache-manager';
import { QueueName } from '../src/integrations/queue/constants/queue.constants';
import { NestFactory } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { sql } from 'kysely';
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
import {
  KnowledgeGraphExpansionMode,
  KnowledgeRetrievalResult,
  KnowledgeRetrievalService,
} from '../src/features/llm-wiki/services/knowledge-retrieval.service';

// DatabaseModule's listeners inject queue producers. Retrieval never enqueues,
// so inert stand-ins keep the script off the shared dev Redis entirely.
const inertQueue = {
  add: () => {
    throw new Error('eval-graph-expansion must not enqueue jobs');
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

// Only what retrieval needs: no queue workers, schedulers or HTTP, so the
// script never competes with a running dev server for jobs.
@Module({
  imports: [
    EnvironmentModule,
    InertQueueModule,
    DatabaseModule,
    EventEmitterModule.forRoot(),
    // In-memory cache: repo caches must not touch the shared dev Redis.
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
  ],
})
class GraphEvalModule {}

type Args = { limit: number; candidateLimit: number; out?: string };

function parseArgs(argv: string[]): Args {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    limit: Number(value('--limit') ?? 50),
    candidateLimit: Number(value('--candidate-limit') ?? 20),
    out: value('--out'),
  };
}

type ChunkView = {
  chunkId: string;
  origin: 'direct' | 'graph';
  pageTitle: string;
  text: string;
};

function view(result: KnowledgeRetrievalResult): ChunkView[] {
  return result.chunks.map((candidate) => ({
    chunkId: candidate.chunk.id,
    origin: candidate.origin,
    pageTitle: candidate.page.title,
    text: candidate.chunk.text.replace(/\s+/gu, ' ').slice(0, 160),
  }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await loadRuntimeConfiguration();
  const app = await NestFactory.createApplicationContext(GraphEvalModule, {
    logger: ['error', 'warn'],
  });

  try {
    const db = app.get<KyselyDB>(KYSELY_MODULE_CONNECTION_TOKEN());
    const retrieval = app.get(KnowledgeRetrievalService);

    const questions = await sql<{
      query: string;
      userId: string;
      workspaceId: string;
    }>`
      SELECT DISTINCT ON (btrim(content))
        btrim(content) AS query,
        user_id AS "userId",
        workspace_id AS "workspaceId"
      FROM ai_chat_messages
      WHERE role = 'user'
        AND deleted_at IS NULL
        AND user_id IS NOT NULL
        AND length(btrim(content)) BETWEEN 4 AND 300
      ORDER BY btrim(content), created_at DESC
      LIMIT ${args.limit}
    `.execute(db);

    const spaceIdsByWorkspace = new Map<string, string[]>();
    const spacesFor = async (workspaceId: string) => {
      const cached = spaceIdsByWorkspace.get(workspaceId);
      if (cached) return cached;
      const rows = await db
        .selectFrom('knowledgePages')
        .select('spaceId')
        .distinct()
        .where('workspaceId', '=', workspaceId)
        .where('staleAt', 'is', null)
        .execute();
      const spaceIds = rows.map((row) => row.spaceId);
      spaceIdsByWorkspace.set(workspaceId, spaceIds);
      return spaceIds;
    };

    const report = [];
    for (const question of questions.rows) {
      const spaceIds = await spacesFor(question.workspaceId);
      if (spaceIds.length === 0) continue;
      const run = (graphExpansionMode: KnowledgeGraphExpansionMode) =>
        retrieval.retrieve({
          workspaceId: question.workspaceId,
          userId: question.userId,
          query: question.query,
          spaceIds,
          candidateLimit: args.candidateLimit,
          graphExpansionMode,
        });
      const legacy = await run('window_recall');
      const anchored = await run('edge_anchored');
      const anchoredChunkIds = new Set(
        anchored.chunks.map((candidate) => candidate.chunk.id),
      );
      const directDistances = anchored.retrievalObservation.candidates
        .filter(
          (candidate) =>
            candidate.stage === 'direct' &&
            candidate.scoreType === 'semantic_distance',
        )
        .map((candidate) => candidate.score);
      report.push({
        query: question.query,
        bestDirectDistance: directDistances.length
          ? Math.min(...directDistances)
          : null,
        legacy: {
          graphSelected: legacy.diagnostics.graph.selectedCount,
          graphCandidates: legacy.diagnostics.graph.candidateCount,
        },
        anchored: {
          graphSelected: anchored.diagnostics.graph.selectedCount,
          graphCandidates: anchored.diagnostics.graph.candidateCount,
          graphGatedOut: anchored.diagnostics.graph.gatedOutCount,
          edgeCounts: anchored.diagnostics.graph.edgeCounts,
        },
        addedGraphChunks: view(anchored).filter(
          (chunk) => chunk.origin === 'graph',
        ),
        displacedDirectChunks: view(legacy).filter(
          (chunk) => !anchoredChunkIds.has(chunk.chunkId),
        ),
      });
    }

    const withGraph = report.filter((row) => row.anchored.graphSelected > 0);
    console.log(
      JSON.stringify(
        {
          questions: report.length,
          legacyQueriesWithGraphHits: report.filter(
            (row) => row.legacy.graphSelected > 0,
          ).length,
          anchoredQueriesWithGraphHits: withGraph.length,
          anchoredGraphChunksTotal: withGraph.reduce(
            (sum, row) => sum + row.anchored.graphSelected,
            0,
          ),
          displacedDirectChunksTotal: report.reduce(
            (sum, row) => sum + row.displacedDirectChunks.length,
            0,
          ),
        },
        null,
        2,
      ),
    );
    for (const row of withGraph) {
      console.log(`\n# ${row.query}`);
      for (const chunk of row.addedGraphChunks) {
        console.log(`  + [${chunk.pageTitle}] ${chunk.text}`);
      }
      for (const chunk of row.displacedDirectChunks) {
        console.log(`  - [${chunk.pageTitle}] ${chunk.text}`);
      }
    }
    if (args.out) {
      writeFileSync(args.out, JSON.stringify(report, null, 2));
      console.log(`\nFull report written to ${args.out}`);
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
