import { NestFactory } from '@nestjs/core';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { KyselyDB } from '../src/database/types/kysely.types';
import { AiKnowledgeChatService } from '../src/ee/llm-wiki/services/ai-knowledge-chat.service';
import { chunkKnowledgeSource } from '../src/ee/llm-wiki/chunking/knowledge-structural-chunker';
import { loadRuntimeConfiguration } from '../src/integrations/environment/consul-config.loader';
import type { Workspace } from '../src/database/types/entity.types';

type CliOptions = {
  email: string;
  query?: string;
  spaceId?: string;
  runId?: string;
  json: boolean;
};

type TextObservation = {
  chars: number;
  genericAttachmentMarkerCount: number;
  exactAttachmentMarkerCount: number;
  containsExactAttachmentMarker: boolean;
  snippets: string[];
};

const DEFAULT_EMAIL = 'xuhong_yao@intsig.net';
const RUN_LOOKBACK = 30;
const SNIPPET_RADIUS = 180;

/**
 * Read-only diagnostic for §9 step 1 of the knowledge-image retrieval plan.
 *
 * This script intentionally calls AiKnowledgeChatService directly instead of
 * the controller. It therefore exercises final citationEvidence generation
 * without writing query audit rows or touching the future image resolver.
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.query) {
    throw new Error(
      'A real image-related query is required. Pass --query "..."; use --help for usage.',
    );
  }

  await loadRuntimeConfiguration();
  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const db = app.get<KyselyDB>(KYSELY_MODULE_CONNECTION_TOKEN());
    const chatService = app.get(AiKnowledgeChatService);
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('email', 'ilike', options.email)
      .where('deletedAt', 'is', null)
      .orderBy('updatedAt', 'desc')
      .executeTakeFirst();
    if (!user?.workspaceId) {
      throw new Error(`Active user with workspace not found: ${options.email}`);
    }

    const workspace = await db
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', user.workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!workspace) throw new Error(`Workspace not found: ${user.workspaceId}`);

    const runAndImage = await findSampleRunAndImage(db, {
      workspaceId: workspace.id,
      spaceId: options.spaceId,
      runId: options.runId,
    });
    if (!runAndImage) {
      throw new Error(
        'No recent succeeded/partial compile run with a succeeded image was found.',
      );
    }

    const page = await db
      .selectFrom('pages')
      .select(['id', 'title', 'textContent'])
      .where('id', '=', runAndImage.image.sourcePageId)
      .executeTakeFirst();
    if (!page) throw new Error(`Page not found: ${runAndImage.image.sourcePageId}`);

    const source = await db
      .selectFrom('knowledgeSources')
      .selectAll()
      .where('workspaceId', '=', workspace.id)
      .where('sourcePageId', '=', page.id)
      .where('sourceSpaceId', '=', runAndImage.run.spaceId)
      .where('staleAt', 'is', null)
      .where('deletedAt', 'is', null)
      .orderBy('updatedAt', 'desc')
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();

    const storedChunks = source
      ? await db
          .selectFrom('knowledgeSourceChunks')
          .select(['id', 'text', 'sourceRange', 'quoteHash'])
          .where('workspaceId', '=', workspace.id)
          .where('sourceId', '=', source.id)
          .orderBy('id', 'asc')
          .execute()
      : [];

    const fallbackText = source?.extractedText ?? page.textContent ?? '';
    const fallbackChunks = chunkKnowledgeSource({
      pageTitle: page.title,
      text: fallbackText,
    }).flatMap((parent) => parent.children);

    const finalResult = await chatService.chat({
      workspaceId: workspace.id,
      userId: user.id,
      query: options.query,
      spaceIds: [runAndImage.run.spaceId],
      workspace: workspace as Workspace,
      // Do not print streamed answer tokens; this is an evidence diagnostic.
      onToken: () => undefined,
    });

    const finalEvidence = finalResult.citationEvidence
      .filter((citation) => citation.sourcePageId === page.id)
      .map((citation) => ({
        sourcePageId: citation.sourcePageId,
        title: citation.title,
        excerpts: citation.excerpts.map((excerpt) => ({
          sourceRange: excerpt.sourceRange,
          quoteHash: excerpt.quoteHash,
          text: excerpt.text,
          observation: observeText(excerpt.text, runAndImage.image.attachmentId),
        })),
      }));

    const report = {
      status: 'completed',
      conclusion: summarizeConclusion({
        source: observeText(source?.extractedText ?? '', runAndImage.image.attachmentId),
        storedChunks: storedChunks.map((chunk) =>
          observeText(chunk.text, runAndImage.image.attachmentId),
        ),
        fallback: observeText(fallbackText, runAndImage.image.attachmentId),
        pageText: observeText(page.textContent ?? '', runAndImage.image.attachmentId),
        finalEvidence,
      }),
      sample: {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        spaceId: runAndImage.run.spaceId,
        spaceName: runAndImage.spaceName,
        runId: runAndImage.run.id,
        runStatus: runAndImage.run.status,
        knowledgeGeneration: runAndImage.run.knowledgeGeneration,
        finishedAt: runAndImage.run.finishedAt,
        sourcePageId: page.id,
        pageTitle: page.title,
        attachmentId: runAndImage.image.attachmentId,
        imageStatus: runAndImage.image.status,
        extractionId: runAndImage.image.extractionId,
        altText: runAndImage.image.altText,
        extraction: runAndImage.extraction,
      },
      query: {
        text: options.query,
        answerMode: finalResult.answerMode,
        citationCount: finalResult.citations.length,
        matchingCitationEvidenceCount: finalEvidence.length,
      },
      observations: {
        enrichmentSourceText: {
          sourceId: source?.id ?? null,
          sourceVersion: source?.sourceVersion ?? null,
          contentHash: source?.contentHash ?? null,
          ...observeText(source?.extractedText ?? '', runAndImage.image.attachmentId),
        },
        persistedSourceChunks: {
          chunkCount: storedChunks.length,
          chunksWithExactMarker: storedChunks.filter((chunk) =>
            hasExactAttachmentMarker(chunk.text, runAndImage.image.attachmentId),
          ).length,
          chunks: storedChunks.map((chunk) => ({
            id: chunk.id,
            sourceRange: chunk.sourceRange,
            quoteHash: chunk.quoteHash,
            ...observeText(chunk.text, runAndImage.image.attachmentId),
          })),
        },
        pageTextFallback: {
          rawPageText: observeText(page.textContent ?? '', runAndImage.image.attachmentId),
          resolverFallbackText: {
            sourceUsed: source?.extractedText ? 'knowledgeSources.extractedText' : 'pages.textContent',
            ...observeText(fallbackText, runAndImage.image.attachmentId),
          },
          generatedFallbackChunkCount: fallbackChunks.length,
          generatedFallbackChunksWithExactMarker: fallbackChunks.filter((chunk) =>
            hasExactAttachmentMarker(chunk.text, runAndImage.image.attachmentId),
          ).length,
        },
        finalCitationEvidence: finalEvidence,
      },
    };

    const output = JSON.stringify(report, null, 2);
    if (options.json) {
      console.log(output);
    } else {
      console.log(output);
      console.error('\n判定：' + report.conclusion.summary);
    }
  } finally {
    await app.close();
  }
}

async function findSampleRunAndImage(
  db: KyselyDB,
  input: { workspaceId: string; spaceId?: string; runId?: string },
) {
  const runs = await db
    .selectFrom('knowledgeSpaceCompileRuns as run')
    .innerJoin('spaces as space', 'space.id', 'run.spaceId')
    .select([
      'run.id',
      'run.spaceId',
      'run.status',
      'run.knowledgeGeneration',
      'run.finishedAt',
      'space.name as spaceName',
    ])
    .where('run.workspaceId', '=', input.workspaceId)
    .where('run.status', 'in', ['succeeded', 'partial'])
    .where('run.finishedAt', 'is not', null)
    .$if(Boolean(input.spaceId), (query) =>
      query.where('run.spaceId', '=', input.spaceId!),
    )
    .$if(Boolean(input.runId), (query) => query.where('run.id', '=', input.runId!))
    .orderBy('run.finishedAt', 'desc')
    .orderBy('run.updatedAt', 'desc')
    .limit(RUN_LOOKBACK)
    .execute();

  for (const run of runs) {
    const image = await db
      .selectFrom('knowledgeSpaceCompileRunImages as image')
      .innerJoin(
        'knowledgeSpaceCompileRunPages as page',
        'page.id',
        'image.runPageId',
      )
      .leftJoin(
        'knowledgeImageExtractions as extraction',
        'extraction.id',
        'image.extractionId',
      )
      .select([
        'image.sourcePageId',
        'image.attachmentId',
        'image.altText',
        'image.extractionId',
        'image.status',
        'extraction.caption',
        'extraction.ocrText',
      ])
      .where('image.runId', '=', run.id)
      .where('image.status', '=', 'succeeded')
      .orderBy('image.sourcePageId', 'asc')
      .orderBy('image.imageOrdinal', 'asc')
      .executeTakeFirst();
    if (image) {
      return {
        run,
        spaceName: run.spaceName,
        image,
        extraction: {
          caption: image.caption,
          ocrText: image.ocrText,
        },
      };
    }
  }
  return undefined;
}

function observeText(text: string, attachmentId: string): TextObservation {
  const genericMatches = text.match(/附件\s*ID\s*[:：]/gi) ?? [];
  const exactMatches = text.match(
    new RegExp(`附件\\s*ID\\s*[:：]\\s*${escapeRegExp(attachmentId)}`, 'gi'),
  ) ?? [];
  const snippets: string[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length && snippets.length < 5) {
    const markerIndex = text.indexOf('附件', searchFrom);
    if (markerIndex < 0) break;
    snippets.push(
      text.slice(
        Math.max(0, markerIndex - SNIPPET_RADIUS),
        Math.min(text.length, markerIndex + SNIPPET_RADIUS),
      ),
    );
    searchFrom = markerIndex + 2;
  }
  return {
    chars: text.length,
    genericAttachmentMarkerCount: genericMatches.length,
    exactAttachmentMarkerCount: exactMatches.length,
    containsExactAttachmentMarker: exactMatches.length > 0,
    snippets,
  };
}

function hasExactAttachmentMarker(text: string, attachmentId: string): boolean {
  return observeText(text, attachmentId).containsExactAttachmentMarker;
}

function summarizeConclusion(input: {
  source: TextObservation;
  storedChunks: TextObservation[];
  fallback: TextObservation;
  pageText: TextObservation;
  finalEvidence: Array<{
    excerpts: Array<{ observation: TextObservation }>;
  }>;
}) {
  const storedChunkHit = input.storedChunks.some(
    (observation) => observation.containsExactAttachmentMarker,
  );
  const evidenceHit = input.finalEvidence.some((citation) =>
    citation.excerpts.some((excerpt) => excerpt.observation.containsExactAttachmentMarker),
  );
  const stableAcrossAvailablePoints =
    input.source.containsExactAttachmentMarker &&
    (input.storedChunks.length === 0 || storedChunkHit) &&
    input.fallback.containsExactAttachmentMarker &&
    evidenceHit;
  const summary = stableAcrossAvailablePoints
    ? '附件 ID 在 source、持久化 chunks、resolver fallback 文本和最终 citationEvidence 中均保留；Evidence 强关联可以作为主路径。'
    : evidenceHit
      ? '最终 citationEvidence 保留附件 ID，Evidence 强关联在本样本可用，但至少一个中间观察点未保留；需扩大样本后再确认“稳定”。'
      : '最终 citationEvidence 未保留附件 ID；本样本不能依赖 Evidence 强关联，后续应以 run image 弱关联为主。';
  return {
    evidenceMarkerFound: evidenceHit,
    sourceMarkerFound: input.source.containsExactAttachmentMarker,
    storedChunksMarkerFound: storedChunkHit,
    fallbackMarkerFound: input.fallback.containsExactAttachmentMarker,
    rawPageTextMarkerFound: input.pageText.containsExactAttachmentMarker,
    stableAcrossAvailablePoints,
    summary,
  };
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: pnpm --filter server exec tsx scripts/diagnose-knowledge-image-evidence.ts [options]

Required:
  --query <text>       Real image-related query to run through AiKnowledgeChatService

Optional:
  --email <email>      Active user used for workspace lookup (default: ${DEFAULT_EMAIL})
  --space-id <uuid>    Restrict sample selection to one space
  --run-id <uuid>      Inspect one compile run instead of the latest matching run
  --json               Emit JSON only
`);
    process.exit(0);
  }

  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    email: value('--email') ?? DEFAULT_EMAIL,
    query: value('--query'),
    spaceId: value('--space-id'),
    runId: value('--run-id'),
    json: argv.includes('--json'),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
