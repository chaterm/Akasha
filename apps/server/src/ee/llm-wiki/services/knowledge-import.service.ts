import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { toSql as vectorToSql } from 'pgvector';
import { InjectKysely } from 'nestjs-kysely';
import { executeTx } from '@akasha/db/utils';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import {
  KnowledgeCapsuleRepo,
  UpsertCompiledArtifactInput,
} from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeQuarantineRepo } from '@akasha/db/repos/llm-wiki/knowledge-quarantine.repo';
import { KnowledgeSourceRepo } from '@akasha/db/repos/llm-wiki/knowledge-source.repo';
import { KnowledgeArtifactContributionRepo } from '@akasha/db/repos/llm-wiki/knowledge-artifact-contribution.repo';
import { JsonValue } from '@akasha/db/types/db';
import {
  CompiledKnowledgeArtifact,
  CompileSpaceInput,
} from '../types/compiler-artifact.types';
import { KnowledgeSourceRef } from '../types/knowledge.types';
import { KnowledgeArtifactValidatorService } from './knowledge-artifact-validator.service';
import {
  buildKnowledgeEmbeddingProfile,
  ConfiguredKnowledgeEmbeddingProvider,
  KnowledgeEmbedding,
  KnowledgeEmbeddingError,
} from './knowledge-embedding-provider.service';
import { KnowledgeVectorIndexService } from './knowledge-vector-index.service';
import { KnowledgeArtifactMaterializerService } from './knowledge-artifact-materializer.service';
import { chunkKnowledgeSource } from '../chunking/knowledge-structural-chunker';
import {
  KnowledgeOperationBudget,
  mapKnowledgeOperations,
} from './knowledge-operation-budget';

export interface KnowledgeImportResult {
  importedArtifactCount: number;
  quarantinedArtifactCount: number;
  degradedRetrievalProfiles?: string[];
  skippedReason?: 'run_superseded';
}

export type KnowledgeImportStage =
  | 'validation'
  | 'merge'
  | 'embedding'
  | 'import';

export interface PreparedKnowledgeImport {
  acceptedArtifacts: CompiledKnowledgeArtifact[];
  quarantineInputs: Array<{
    artifactId: string;
    artifactKind: string | null;
    compilerRunId: string | null;
    compileTaskId: string | null;
    reasonCodes: string[];
  }>;
  quarantinedArtifactCount: number;
}

export class KnowledgeCompilationValidationError extends Error {
  readonly code = 'validation_failed';
  readonly retryable = false;

  constructor() {
    super('Knowledge compiler output failed validation.');
    this.name = 'KnowledgeCompilationValidationError';
  }
}

@Injectable()
export class KnowledgeImportService {
  constructor(
    private readonly sourceRepo: KnowledgeSourceRepo,
    private readonly capsuleRepo: KnowledgeCapsuleRepo,
    private readonly validator: KnowledgeArtifactValidatorService,
    private readonly embeddingProvider: ConfiguredKnowledgeEmbeddingProvider,
    private readonly quarantineRepo: KnowledgeQuarantineRepo,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly vectorIndex: KnowledgeVectorIndexService,
    private readonly contributionRepo: KnowledgeArtifactContributionRepo,
    private readonly materializer: KnowledgeArtifactMaterializerService,
  ) {}

  async importCompileResult(input: {
    input: CompileSpaceInput;
    artifacts: CompiledKnowledgeArtifact[];
    onStage?: (stage: KnowledgeImportStage) => void | Promise<void>;
    upsertSources?: boolean;
    retireSources?: boolean;
    retireCompileScope?: boolean;
    publicationGuard?: (trx: KyselyTransaction) => Promise<boolean>;
    publicationComplete?: (trx: KyselyTransaction) => Promise<void>;
    preparedImport?: PreparedKnowledgeImport;
    onPrepared?: (prepared: PreparedKnowledgeImport) => void | Promise<void>;
  }): Promise<KnowledgeImportResult> {
    const operationBudget =
      input.input.operationBudget ?? new KnowledgeOperationBudget();
    input.input.operationBudget = operationBudget;
    operationBudget.throwIfAborted();
    if (!input.preparedImport) await input.onStage?.('validation');
    const validation = input.preparedImport
      ? {
          accepted: input.preparedImport.acceptedArtifacts,
          quarantined: [],
        }
      : this.validator.validateCompileResult(input);
    operationBudget.assertArtifactCount(validation.accepted.length);
    operationBudget.assertChunkCount(
      validation.accepted.reduce(
        (count, artifact) => count + (artifact.chunks?.length ?? 0),
        0,
      ),
    );

    const quarantineInputs =
      input.preparedImport?.quarantineInputs ??
      validation.quarantined.map((quarantined) => ({
        artifactId: quarantined.artifact.artifactId,
        artifactKind: quarantined.artifact.artifactKind ?? null,
        compilerRunId: quarantined.artifact.compilerRunId ?? null,
        compileTaskId: quarantined.artifact.compileTaskId ?? null,
        reasonCodes: toQuarantineReasonCodes(quarantined.reasons),
      }));
    const isSemanticPagePublication =
      input.input.compileMode === 'pages' && input.input.sources.length === 1;
    if (isSemanticPagePublication && quarantineInputs.length > 0) {
      let quarantinePublicationRejected = false;
      await executeTx(this.db, async (trx) => {
        if (input.publicationGuard && !(await input.publicationGuard(trx))) {
          quarantinePublicationRejected = true;
          return;
        }
        await this.quarantineRepo.recordQuarantinedArtifacts(
          {
            workspaceId: input.input.workspaceId,
            spaceId: input.input.spaceId,
            artifacts: quarantineInputs,
          },
          trx,
        );
      });
      if (quarantinePublicationRejected) {
        return {
          importedArtifactCount: 0,
          quarantinedArtifactCount: 0,
          skippedReason: 'run_superseded',
        };
      }
      throw new KnowledgeCompilationValidationError();
    }

    let artifactsToPublish = validation.accepted;
    let contributionPublication:
      | {
          sourcePageId: string;
          contributions: Parameters<
            KnowledgeArtifactContributionRepo['replaceSourceContributions']
          >[0]['contributions'];
          removedArtifactIds: string[];
        }
      | undefined;
    if (isSemanticPagePublication) {
      await input.onStage?.('merge');
      const source = input.input.sources[0];
      const previousSourceContributions =
        await this.contributionRepo.findBySourcePage({
          workspaceId: input.input.workspaceId,
          spaceId: input.input.spaceId,
          sourcePageId: source.sourcePageId,
        });
      const affectedArtifactIds = [
        ...new Set([
          ...previousSourceContributions.map((item) => item.artifactId),
          ...validation.accepted.map((artifact) => artifact.artifactId),
        ]),
      ];
      const affectedContributions =
        await this.contributionRepo.findByArtifactIds({
          workspaceId: input.input.workspaceId,
          spaceId: input.input.spaceId,
          artifactIds: affectedArtifactIds,
        });
      const materialized = await this.materializer.materializeSourceUpdate({
        sourcePageId: source.sourcePageId,
        previousSourceContributions,
        affectedContributions,
        incomingArtifacts: validation.accepted,
        operationBudget,
      });
      artifactsToPublish = materialized.artifacts;
      operationBudget.assertChunkCount(
        artifactsToPublish.reduce(
          (count, artifact) => count + (artifact.chunks?.length ?? 0),
          0,
        ),
      );
      contributionPublication = {
        sourcePageId: source.sourcePageId,
        removedArtifactIds: materialized.removedArtifactIds,
        contributions: validation.accepted.map((artifact) => {
          if (!artifact.artifactKind || !artifact.canonicalKey) {
            throw new Error(
              'semantic artifact contribution requires kind and canonical key',
            );
          }
          return {
            id: stableUuid(
              `${input.input.workspaceId}:${source.sourcePageId}:${artifact.artifactId}`,
            ),
            workspaceId: input.input.workspaceId,
            spaceId: input.input.spaceId,
            sourcePageId: source.sourcePageId,
            sourceVersion: source.sourceVersion,
            sourceContentHash: source.contentHash,
            artifactId: artifact.artifactId,
            artifactKind: artifact.artifactKind,
            canonicalKey: artifact.canonicalKey,
            compilerVersion: artifact.compilerVersion,
            promptVersion: artifact.promptVersion,
            compilerRunId: artifact.compilerRunId!,
            compileTaskId: artifact.compileTaskId!,
            artifact: toJsonValue(artifact),
          };
        }),
      };
    }

    if (!input.preparedImport) {
      await input.onPrepared?.({
        acceptedArtifacts: validation.accepted,
        quarantineInputs,
        quarantinedArtifactCount: validation.quarantined.length,
      });
    }

    await input.onStage?.('embedding');

    const artifactInputs: UpsertCompiledArtifactInput[] = [];

    for (const artifact of artifactsToPublish) {
      const artifactChunks = await mapKnowledgeOperations(
        artifact.chunks ?? [],
        async (chunk) => {
          const suppliedEmbedding = compilerEmbedding(
            chunk.embedding,
            artifact.compilerVersion,
          );

          const embedding = suppliedEmbedding
            ? suppliedEmbedding
            : await this.embedRequired(
                chunk.embeddingText ?? chunk.text,
                operationBudget.signal,
              );
          return {
            ...chunk,
            embedding,
          };
        },
      );
      const claims = (artifact.claims ?? []).map((claim, index) => ({
        id: stableUuid(`${artifact.artifactId}:claim:${index}`),
        workspaceId: artifact.workspaceId,
        spaceId: artifact.spaceId,
        knowledgePageId: artifact.artifactId,
        text: claim.text,
        confidence: claim.confidence ?? null,
        position: index,
        compilerRunId: artifact.compilerRunId ?? null,
        compileTaskId: artifact.compileTaskId ?? null,
        staleAt: null,
      }));
      const parentSections = (artifact.parentSections ?? []).map((parent) => ({
        id: stableUuid(`${artifact.artifactId}:parent:${parent.stableKey}`),
        workspaceId: artifact.workspaceId,
        spaceId: artifact.spaceId,
        knowledgePageId: artifact.artifactId,
        stableKey: parent.stableKey,
        headingPath: parent.headingPath,
        text: parent.text,
        contentHash: parent.contentHash ?? hashContent(parent.text),
        startOffset: parent.startOffset ?? null,
        endOffset: parent.endOffset ?? null,
        staleAt: null,
      }));
      const parentIdByStableKey = new Map(
        parentSections.map((parent) => [parent.stableKey, parent.id]),
      );
      const parentSectionSources = parentSections.flatMap((parent, index) =>
        (
          artifact.parentSections?.[index]?.inputSourceRefs ??
          artifact.inputSourceRefs ??
          []
        ).map((source) => ({
          workspaceId: artifact.workspaceId,
          parentSectionId: parent.id,
          sourcePageId: source.sourcePageId,
          sourceVersion: source.sourceVersion,
          sourceRange: toStoredSourceRange(source),
          quoteHash: source.quoteHash ?? null,
          contentHash: source.contentHash,
          provenanceKind: 'source_evidence',
          attachmentId: null,
        })),
      );
      const claimSources = claims.flatMap((claim, index) =>
        (
          artifact.claims?.[index]?.inputSourceRefs ??
          artifact.inputSourceRefs ??
          []
        ).map((source) => ({
          workspaceId: artifact.workspaceId,
          claimId: claim.id,
          sourcePageId: source.sourcePageId,
          sourceVersion: source.sourceVersion,
          sourceRange: toStoredSourceRange(source),
          quoteHash: source.quoteHash ?? null,
          contentHash: source.contentHash,
          provenanceKind: 'synthesis_lineage',
          attachmentId: null,
        })),
      );
      const chunks = artifactChunks.map((chunk, index) => ({
        id: stableUuid(`${artifact.artifactId}:chunk:${index}`),
        workspaceId: artifact.workspaceId,
        spaceId: artifact.spaceId,
        knowledgePageId: artifact.artifactId,
        claimId:
          chunk.claimIndex !== undefined && chunk.claimIndex !== null
            ? (claims[chunk.claimIndex]?.id ?? null)
            : null,
        text: chunk.text,
        contentHash: chunk.contentHash ?? hashContent(chunk.text),
        embedding: chunk.embedding ? vectorToSql(chunk.embedding.vector) : null,
        embeddingLegacy: chunk.embedding?.vector ?? null,
        embeddingProfile: chunk.embedding?.profile ?? null,
        embeddingModel: chunk.embedding?.model ?? null,
        embeddingDimensions: chunk.embedding?.dimensions ?? null,
        parentSectionId: chunk.parentStableKey
          ? (parentIdByStableKey.get(chunk.parentStableKey) ?? null)
          : null,
        stableKey:
          chunk.stableKey ?? `${artifact.artifactId}:legacy-chunk:${index}`,
        chunkRole: chunk.chunkRole ?? 'standalone',
        retrievalChannel: chunk.retrievalChannel ?? 'memory',
        headingPath: chunk.headingPath ?? [],
        startOffset: chunk.startOffset ?? null,
        endOffset: chunk.endOffset ?? null,
        compilerRunId: artifact.compilerRunId ?? null,
        compileTaskId: artifact.compileTaskId ?? null,
        staleAt: null,
      }));
      const chunkSources = chunks.flatMap((chunk, index) =>
        (
          artifact.chunks?.[index]?.inputSourceRefs ??
          artifact.inputSourceRefs ??
          []
        ).map((source) => ({
          workspaceId: artifact.workspaceId,
          chunkId: chunk.id,
          sourcePageId: source.sourcePageId,
          sourceVersion: source.sourceVersion,
          sourceRange: toStoredSourceRange(source),
          quoteHash: source.quoteHash ?? null,
          contentHash: source.contentHash,
          provenanceKind: 'synthesis_lineage',
          attachmentId: null,
        })),
      );
      const links = (artifact.links ?? []).map((link, index) => {
        const linkId = stableUuid(`${artifact.artifactId}:link:${index}`);

        return {
          id: linkId,
          workspaceId: artifact.workspaceId,
          spaceId: artifact.spaceId,
          fromKnowledgePageId: artifact.artifactId,
          toKnowledgePageId: link.toKnowledgePageId ?? null,
          targetPageId: link.targetPageId ?? null,
          targetSpaceId: link.targetSpaceId ?? null,
          targetArtifactKind: link.targetArtifactKind ?? null,
          targetCanonicalKey: link.targetCanonicalKey ?? null,
          linkText: link.linkText ?? '',
          linkType: link.linkType,
          isDangling:
            link.isDangling ??
            (link.isOpaque === true || !link.toKnowledgePageId),
          compilerRunId: artifact.compilerRunId ?? null,
          compileTaskId: artifact.compileTaskId ?? null,
          staleAt: null,
        };
      });
      const linkSources = links.flatMap((link, index) =>
        (
          artifact.links?.[index]?.inputSourceRefs ??
          artifact.inputSourceRefs ??
          []
        ).map((source) => ({
          workspaceId: artifact.workspaceId,
          linkId: link.id,
          sourcePageId: source.sourcePageId,
          sourceVersion: source.sourceVersion,
          sourceRange: toStoredSourceRange(source),
          quoteHash: source.quoteHash ?? null,
          contentHash: source.contentHash,
          provenanceKind: 'synthesis_lineage',
          attachmentId: null,
        })),
      );
      const graphEdges = (artifact.graphEdges ?? []).map((edge, index) => ({
        id: stableUuid(`${artifact.artifactId}:graph-edge:${index}`),
        workspaceId: artifact.workspaceId,
        spaceId: artifact.spaceId,
        fromKnowledgePageId: artifact.artifactId,
        toKnowledgePageId: edge.toKnowledgePageId,
        relation: edge.relation,
        compilerRunId: artifact.compilerRunId ?? null,
        compileTaskId: artifact.compileTaskId ?? null,
        staleAt: null,
      }));
      const graphEdgeSources = graphEdges.flatMap((edge, index) =>
        (
          artifact.graphEdges?.[index]?.inputSourceRefs ??
          artifact.inputSourceRefs ??
          []
        ).map((source) => ({
          workspaceId: artifact.workspaceId,
          graphEdgeId: edge.id,
          sourcePageId: source.sourcePageId,
          sourceVersion: source.sourceVersion,
          sourceRange: toStoredSourceRange(source),
          quoteHash: source.quoteHash ?? null,
          contentHash: source.contentHash,
          provenanceKind: 'synthesis_lineage',
          attachmentId: null,
        })),
      );

      artifactInputs.push({
        page: {
          id: artifact.artifactId,
          workspaceId: artifact.workspaceId,
          spaceId: artifact.spaceId,
          compileScope: input.input.compileMode === 'pages' ? 'page' : 'space',
          title: artifact.title,
          slug: artifact.artifactId,
          body: artifact.contentMarkdown,
          canonicalKey:
            artifact.canonicalKey ?? artifact.rawArtifactKey ?? null,
          summary: null,
          pageType: artifact.artifactKind ?? null,
          compiledAt: new Date(),
          compilerVersion: artifact.compilerVersion,
          compilerRunId: artifact.compilerRunId ?? null,
          compileTaskId: artifact.compileTaskId ?? null,
          generationMode:
            artifact.generationMode ??
            (isSemanticPagePublication ? 'semantic' : 'legacy'),
          staleAt: null,
        },
        pageSources: (artifact.inputSourceRefs ?? []).map((source) => ({
          workspaceId: artifact.workspaceId,
          knowledgePageId: artifact.artifactId,
          sourcePageId: source.sourcePageId,
          sourceVersion: source.sourceVersion,
          sourceRange: toStoredSourceRange(source),
          quoteHash: source.quoteHash ?? null,
          contentHash: source.contentHash,
          provenanceKind: 'synthesis_lineage',
          attachmentId: null,
        })),
        parentSections,
        parentSectionSources,
        claims,
        claimSources,
        chunks,
        chunkSources,
        links,
        linkSources,
        graphEdges,
        graphEdgeSources,
      });
    }

    await input.onStage?.('import');

    const embeddingProfiles = new Map<string, number>();
    for (const chunk of artifactInputs.flatMap(
      (artifact) => artifact.chunks ?? [],
    )) {
      if (chunk.embeddingProfile && chunk.embeddingDimensions) {
        embeddingProfiles.set(
          String(chunk.embeddingProfile),
          Number(chunk.embeddingDimensions),
        );
      }
    }
    const degradedRetrievalProfiles: string[] = [];
    await Promise.all(
      [...embeddingProfiles].map(async ([profile, dimensions]) => {
        try {
          const result = await this.vectorIndex.ensureProfileIndex({
            profile,
            dimensions,
          });
          if (result === 'exact-only') {
            degradedRetrievalProfiles.push(profile);
          }
        } catch {
          degradedRetrievalProfiles.push(profile);
        }
      }),
    );

    const persistSources =
      input.upsertSources !== false && input.input.sources.length > 0;
    let publicationRejected = false;
    if (
      persistSources ||
      artifactInputs.length > 0 ||
      quarantineInputs.length > 0 ||
      Boolean(contributionPublication) ||
      input.retireSources === true ||
      input.retireCompileScope === true
    ) {
      operationBudget.throwIfAborted();
      await executeTx(this.db, async (trx) => {
        if (input.publicationGuard && !(await input.publicationGuard(trx))) {
          publicationRejected = true;
          return;
        }

        if (input.retireSources) {
          await this.sourceRepo.markSpaceSourcesStale(
            {
              workspaceId: input.input.workspaceId,
              spaceId: input.input.spaceId,
              sourcePageIds: uniqueSourcePageIds(input.input),
            },
            trx,
          );
        }

        if (input.retireCompileScope) {
          await this.capsuleRepo.markCompileScopeStale(
            {
              workspaceId: input.input.workspaceId,
              spaceId: input.input.spaceId,
            },
            trx,
          );
        }

        if (persistSources) {
          for (const source of input.input.sources) {
            const sourceRow = await this.sourceRepo.upsertPageSource(
              {
                workspaceId: source.workspaceId,
                sourcePageId: source.sourcePageId,
                sourceSpaceId: source.spaceId,
                sourceType: 'docmost_page',
                sourceVersion: source.sourceVersion,
                contentHash: source.contentHash,
                extractedText: source.text,
                mimeType: 'text/plain',
              },
              trx,
            );
            const sourceChunks = chunkKnowledgeSource({
              pageTitle: source.title,
              text: source.text,
            }).flatMap((parent) =>
              parent.children.map((child) => ({
                id: stableUuid(
                  `${sourceRow.id}:${child.startOffset}:${child.endOffset}:${child.quoteHash}`,
                ),
                text: child.text,
                contentHash: child.quoteHash,
                sourceRange: {
                  startOffset: child.startOffset,
                  endOffset: child.endOffset,
                },
                quoteHash: child.quoteHash,
              })),
            );
            await this.sourceRepo.replaceSourceChunks(
              {
                workspaceId: source.workspaceId,
                sourceId: sourceRow.id,
                sourcePageId: source.sourcePageId,
                chunks: sourceChunks,
              },
              trx,
            );
          }
        }

        if (contributionPublication) {
          // Semantic artifacts use canonical IDs, so rollout from the older
          // deterministic compiler can otherwise leave two active summaries
          // for one source. Stale source-owned summaries and publish the new
          // canonical summary in the same transaction.
          await this.capsuleRepo.markSourceArtifactsStaleBySourcePageIds(
            {
              workspaceId: input.input.workspaceId,
              spaceId: input.input.spaceId,
              sourcePageIds: [contributionPublication.sourcePageId],
            },
            trx,
          );
          await this.contributionRepo.replaceSourceContributions(
            {
              workspaceId: input.input.workspaceId,
              spaceId: input.input.spaceId,
              sourcePageId: contributionPublication.sourcePageId,
              contributions: contributionPublication.contributions,
            },
            trx,
          );
          await this.capsuleRepo.markArtifactsStaleByIds(
            {
              workspaceId: input.input.workspaceId,
              artifactIds: contributionPublication.removedArtifactIds,
            },
            trx,
          );
        } else if (input.retireSources) {
          await this.capsuleRepo.markSourceArtifactsStaleBySourcePageIds(
            {
              workspaceId: input.input.workspaceId,
              spaceId: input.input.spaceId,
              sourcePageIds: uniqueSourcePageIds(input.input),
            },
            trx,
          );
        } else if (
          artifactInputs.length > 0 &&
          input.retireCompileScope !== true
        ) {
          if (input.input.compileMode === 'pages') {
            await this.capsuleRepo.markSourceArtifactsStaleBySourcePageIds(
              {
                workspaceId: input.input.workspaceId,
                spaceId: input.input.spaceId,
                sourcePageIds: uniqueSourcePageIds(input.input),
              },
              trx,
            );
          } else {
            await this.capsuleRepo.markCompileScopeStale(
              {
                workspaceId: input.input.workspaceId,
                spaceId: input.input.spaceId,
              },
              trx,
            );
          }
        }

        if (quarantineInputs.length > 0) {
          await this.quarantineRepo.recordQuarantinedArtifacts(
            {
              workspaceId: input.input.workspaceId,
              spaceId: input.input.spaceId,
              artifacts: quarantineInputs,
            },
            trx,
          );
        }

        if (artifactInputs.length > 0) {
          await this.capsuleRepo.upsertCompiledArtifacts(artifactInputs, trx);
        }

        operationBudget.throwIfAborted();
        await input.publicationComplete?.(trx);
      });
    }

    if (publicationRejected) {
      return {
        importedArtifactCount: 0,
        quarantinedArtifactCount: 0,
        skippedReason: 'run_superseded',
      };
    }

    return {
      importedArtifactCount: validation.accepted.length,
      quarantinedArtifactCount:
        input.preparedImport?.quarantinedArtifactCount ??
        validation.quarantined.length,
      ...(degradedRetrievalProfiles.length > 0
        ? {
            degradedRetrievalProfiles: [
              ...new Set(degradedRetrievalProfiles),
            ].sort(),
          }
        : {}),
    };
  }

  private async embedRequired(
    text: string,
    abortSignal?: AbortSignal,
  ): Promise<KnowledgeEmbedding> {
    if (typeof this.embeddingProvider.embedRequired === 'function') {
      return abortSignal
        ? this.embeddingProvider.embedRequired(text, { abortSignal })
        : this.embeddingProvider.embedRequired(text);
    }

    // Compatibility for injected test/dummy providers that implement the
    // original best-effort interface. Production always uses embedRequired.
    const result = abortSignal
      ? await this.embeddingProvider.embedQuery(text, { abortSignal })
      : await this.embeddingProvider.embedQuery(text);
    if (!result) {
      throw new KnowledgeEmbeddingError(
        'embedding_provider_error',
        'Knowledge embedding provider request failed.',
        true,
      );
    }
    return result;
  }
}

export function parsePreparedKnowledgeImport(
  value: JsonValue,
): PreparedKnowledgeImport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Pending knowledge import is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.acceptedArtifacts) ||
    !Array.isArray(record.quarantineInputs) ||
    typeof record.quarantinedArtifactCount !== 'number'
  ) {
    throw new Error('Pending knowledge import is invalid.');
  }
  return value as unknown as PreparedKnowledgeImport;
}

export function serializePreparedKnowledgeImport(
  value: PreparedKnowledgeImport,
): JsonValue {
  return toJsonValue(value);
}

function uniqueSourcePageIds(input: CompileSpaceInput): string[] {
  return [...new Set(input.sources.map((source) => source.sourcePageId))];
}

function compilerEmbedding(
  value: unknown,
  compilerVersion: string,
): KnowledgeEmbedding | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'number' || !Number.isFinite(item))
  ) {
    return null;
  }

  const vector = value as number[];
  return {
    vector,
    profile: buildKnowledgeEmbeddingProfile({
      driver: 'compiler',
      model: compilerVersion,
      dimensions: vector.length,
    }),
    model: compilerVersion,
    dimensions: vector.length,
  };
}

function hashContent(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function toStoredSourceRange(source: KnowledgeSourceRef) {
  if (!source.sourceRange) return null;

  return {
    startOffset: source.sourceRange.startOffset,
    endOffset: source.sourceRange.endOffset,
  };
}

function stableUuid(input: string): string {
  const hash = createHash('sha256').update(input).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) +
      hash.slice(18, 20),
    hash.slice(20, 32),
  ].join('-');
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

const QUARANTINE_REASON_CODES = new Map<string, string>([
  ['artifact scope does not match compile scope', 'artifact_scope_mismatch'],
  ['artifact id must be a UUID', 'artifact_id_invalid'],
  ['synthesis lineage is incomplete', 'synthesis_lineage_incomplete'],
  ['artifact kind is not supported', 'artifact_kind_unsupported'],
  [
    'artifact source is not in compile input',
    'artifact_source_outside_compile_input',
  ],
  ['artifact source range is invalid', 'artifact_source_range_invalid'],
  [
    'artifact quote hash does not match source range',
    'artifact_quote_hash_mismatch',
  ],
  [
    'artifact source page ids must match synthesis lineage',
    'artifact_source_page_ids_mismatch',
  ],
  ['claim lineage is incomplete', 'claim_lineage_incomplete'],
  [
    'claim source is not in compile input',
    'claim_source_outside_compile_input',
  ],
  ['claim source range is invalid', 'claim_source_range_invalid'],
  ['claim quote hash does not match source range', 'claim_quote_hash_mismatch'],
  ['cross-space references must be opaque', 'cross_space_reference_not_opaque'],
  ['link lineage is incomplete', 'link_lineage_incomplete'],
  ['link source is not in compile input', 'link_source_outside_compile_input'],
  ['link source range is invalid', 'link_source_range_invalid'],
  ['link quote hash does not match source range', 'link_quote_hash_mismatch'],
  ['graph edge target id must be a UUID', 'graph_edge_target_id_invalid'],
  ['graph edge lineage is incomplete', 'graph_edge_lineage_incomplete'],
  [
    'graph edge source is not in compile input',
    'graph_edge_source_outside_compile_input',
  ],
  ['graph edge source range is invalid', 'graph_edge_source_range_invalid'],
  [
    'graph edge quote hash does not match source range',
    'graph_edge_quote_hash_mismatch',
  ],
]);

function toQuarantineReasonCodes(reasons: string[]): string[] {
  const codes = reasons.map(
    (reason) => QUARANTINE_REASON_CODES.get(reason) ?? 'validation_failed',
  );

  return Array.from(new Set(codes.length > 0 ? codes : ['validation_failed']));
}
