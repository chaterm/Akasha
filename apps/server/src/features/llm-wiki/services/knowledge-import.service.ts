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
  BAILIAN_TEXT_EMBEDDING_V4_MAX_INPUTS_PER_REQUEST,
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
import { stableKnowledgeUuid } from './knowledge-stable-id';
import { runKnowledgeCompilationOperation } from '../../../common/helpers/knowledge-compilation-error';

// This slices every content type, not only table rows. Batching does not alter
// individual embedding inputs, so prose/attachment vector quality is unchanged.
// The constant is the Bailian text-embedding-v4 per-request item limit.
const KNOWLEDGE_EMBEDDING_BATCH_SIZE =
  BAILIAN_TEXT_EMBEDDING_V4_MAX_INPUTS_PER_REQUEST;

export interface KnowledgeEmbeddingReuseStats {
  reusedCount: number;
  generatedCount: number;
  /** Stored candidates re-embedded because their profile did not match. */
  profileMismatchCount: number;
}

export interface KnowledgeImportResult {
  importedArtifactCount: number;
  quarantinedArtifactCount: number;
  degradedRetrievalProfiles?: string[];
  skippedReason?: 'run_superseded';
  embedding?: KnowledgeEmbeddingReuseStats;
  /** Largest merged shared artifact in this publication, for sizing the cap. */
  largestSharedArtifact?: {
    artifactId: string;
    canonicalKey: string | null;
    chunkCount: number;
  };
}

export type KnowledgeImportStage =
  | 'validation'
  | 'merge'
  | 'embedding'
  | 'import';

type ArtifactChunk = NonNullable<CompiledKnowledgeArtifact['chunks']>[number];
type ChunkIdentity = { id: string; stableKey: string };
type EmbeddedArtifactChunk = Omit<ArtifactChunk, 'embedding'> & {
  embedding: KnowledgeEmbedding;
};

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
    publicationGuard?: (trx: KyselyTransaction) => Promise<boolean>;
    publicationComplete?: (trx: KyselyTransaction) => Promise<void>;
  }): Promise<KnowledgeImportResult> {
    const operationBudget =
      input.input.operationBudget ?? new KnowledgeOperationBudget();
    input.input.operationBudget = operationBudget;
    operationBudget.throwIfAborted();
    await input.onStage?.('validation');
    const validation = this.validator.validateCompileResult(input);
    operationBudget.assertArtifactCount(validation.accepted.length);
    assertPublicationChunkBudgets(operationBudget, validation.accepted);

    const quarantineInputs = validation.quarantined.map((quarantined) => ({
      artifactId: quarantined.artifact.artifactId,
      artifactKind: quarantined.artifact.artifactKind ?? null,
      compilerRunId: quarantined.artifact.compilerRunId ?? null,
      compileTaskId: quarantined.artifact.compileTaskId ?? null,
      reasonCodes: toQuarantineReasonCodes(quarantined.reasons),
    }));
    const isOriginalPagePublication = input.input.indexMode === 'original';
    const isSemanticPagePublication =
      input.input.sources.length === 1 && !isOriginalPagePublication;
    if (
      (isSemanticPagePublication || isOriginalPagePublication) &&
      quarantineInputs.length > 0
    ) {
      let quarantinePublicationRejected = false;
      await runKnowledgeCompilationOperation('import.transaction', () =>
        executeTx(this.db, async (trx) => {
          if (input.publicationGuard && !(await input.publicationGuard(trx))) {
            quarantinePublicationRejected = true;
            return;
          }
          await runKnowledgeCompilationOperation('import.quarantine', () =>
            this.quarantineRepo.recordQuarantinedArtifacts(
              {
                workspaceId: input.input.workspaceId,
                spaceId: input.input.spaceId,
                artifacts: quarantineInputs,
              },
              trx,
            ),
          );
        }),
      );
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
    let largestSharedArtifact: KnowledgeImportResult['largestSharedArtifact'];
    let contributionPublication:
      | {
          sourcePageId: string;
          contributions: Parameters<
            KnowledgeArtifactContributionRepo['replaceSourceContributions']
          >[0]['contributions'];
          removedArtifactIds: string[];
        }
      | undefined;
    if (isSemanticPagePublication || isOriginalPagePublication) {
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
        incomingArtifacts: isOriginalPagePublication ? [] : validation.accepted,
        ...(isOriginalPagePublication
          ? { mergeMode: 'deterministic' as const }
          : {}),
        operationBudget,
      });
      artifactsToPublish = isOriginalPagePublication
        ? [...materialized.artifacts, ...validation.accepted]
        : materialized.artifacts;
      // Materialized artifacts union chunks from every source contribution, so
      // they are checked one artifact at a time against the shared limit. The
      // source-page budget above already covered this page's own output; the
      // history of other sources must not be charged to this page.
      largestSharedArtifact = assertSharedArtifactChunkBudgets(
        operationBudget,
        materialized.artifacts,
      );
      contributionPublication = {
        sourcePageId: source.sourcePageId,
        removedArtifactIds: materialized.removedArtifactIds,
        contributions: (isOriginalPagePublication
          ? []
          : validation.accepted
        ).map((artifact) => {
          if (!artifact.artifactKind || !artifact.canonicalKey) {
            throw new Error(
              'semantic artifact contribution requires kind and canonical key',
            );
          }
          return {
            id: stableKnowledgeUuid(
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

    await input.onStage?.('embedding');

    const artifactInputs: UpsertCompiledArtifactInput[] = [];
    const chunkIdentitiesByArtifactId = new Map(
      artifactsToPublish.map((artifact) => [
        artifact.artifactId,
        buildChunkIdentities(artifact),
      ]),
    );
    const {
      chunksByArtifactId: embeddedChunksByArtifactId,
      stats: embeddingStats,
    } = await this.embedArtifactChunks(
      artifactsToPublish,
      chunkIdentitiesByArtifactId,
      operationBudget,
    );

    for (const artifact of artifactsToPublish) {
      const artifactChunks =
        embeddedChunksByArtifactId.get(artifact.artifactId) ?? [];
      const parentSections = (artifact.parentSections ?? []).map((parent) => ({
        id: stableKnowledgeUuid(
          `${artifact.artifactId}:parent:${parent.stableKey}`,
        ),
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
        })),
      );
      const chunkIdentities =
        chunkIdentitiesByArtifactId.get(artifact.artifactId) ?? [];
      const chunks = artifactChunks.map((chunk, index) => ({
        id: chunkIdentities[index].id,
        workspaceId: artifact.workspaceId,
        spaceId: artifact.spaceId,
        knowledgePageId: artifact.artifactId,
        text: chunk.text,
        contentHash: chunk.contentHash ?? hashContent(chunk.text),
        embedding: chunk.embedding ? vectorToSql(chunk.embedding.vector) : null,
        embeddingProfile: chunk.embedding?.profile ?? null,
        embeddingModel: chunk.embedding?.model ?? null,
        embeddingDimensions: chunk.embedding?.dimensions ?? null,
        embeddingTotalTokens: chunk.embedding?.totalTokens ?? null,
        embeddingDurationMs: chunk.embedding?.durationMs ?? null,
        parentSectionId: chunk.parentStableKey
          ? (parentIdByStableKey.get(chunk.parentStableKey) ?? null)
          : null,
        stableKey: chunkIdentities[index].stableKey,
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
        })),
      );
      // Chunk id reuses the same deterministic key as the chunk row so the
      // relation rows publish in the same transaction; occurrence_order keeps
      // the in-block order for repeated attachments (§6.1 / §6.2).
      const chunkAttachments = chunks.flatMap((chunk, index) =>
        (artifact.chunks?.[index]?.attachmentOccurrences ?? []).map(
          (occurrence, occurrenceOrder) => ({
            workspaceId: artifact.workspaceId,
            chunkId: chunk.id,
            occurrenceOrder,
            attachmentId: occurrence.attachmentId,
            sourcePageId: occurrence.sourcePageId,
            sourceVersion: occurrence.sourceVersion,
            sourceContentHash: occurrence.sourceContentHash,
            attachmentUpdatedAt: new Date(occurrence.attachmentUpdatedAt),
          }),
        ),
      );
      const links = (artifact.links ?? []).map((link, index) => {
        const linkId = stableKnowledgeUuid(
          `${artifact.artifactId}:link:${index}`,
        );

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
        })),
      );
      artifactInputs.push({
        page: {
          id: artifact.artifactId,
          workspaceId: artifact.workspaceId,
          spaceId: artifact.spaceId,
          compileScope: 'page',
          title: artifact.title,
          slug: artifact.artifactId,
          body: artifact.contentMarkdown,
          canonicalKey:
            artifact.canonicalKey ?? artifact.rawArtifactKey ?? null,
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
        })),
        parentSections,
        parentSectionSources,
        chunks,
        chunkSources,
        chunkAttachments,
        links,
        linkSources,
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
      input.retireSources === true
    ) {
      operationBudget.throwIfAborted();
      await runKnowledgeCompilationOperation('import.transaction', () =>
        executeTx(this.db, async (trx) => {
          if (input.publicationGuard && !(await input.publicationGuard(trx))) {
            publicationRejected = true;
            return;
          }

          if (input.retireSources) {
            await runKnowledgeCompilationOperation(
              'import.retire_sources',
              () =>
                this.sourceRepo.markSpaceSourcesStale(
                  {
                    workspaceId: input.input.workspaceId,
                    spaceId: input.input.spaceId,
                    sourcePageIds: uniqueSourcePageIds(input.input),
                  },
                  trx,
                ),
            );
          }

          if (persistSources) {
            for (const source of input.input.sources) {
              const sourceRow = await runKnowledgeCompilationOperation(
                'import.upsert_source',
                () =>
                  this.sourceRepo.upsertPageSource(
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
                  ),
              );
              const sourceChunks = chunkKnowledgeSource({
                pageTitle: source.title,
                text: source.text,
              }).flatMap((parent) =>
                parent.children.map((child) => ({
                  id: stableKnowledgeUuid(
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
              await runKnowledgeCompilationOperation(
                'import.replace_source_chunks',
                () =>
                  this.sourceRepo.replaceSourceChunks(
                    {
                      workspaceId: source.workspaceId,
                      sourceId: sourceRow.id,
                      sourcePageId: source.sourcePageId,
                      chunks: sourceChunks,
                    },
                    trx,
                  ),
              );
            }
          }

          if (contributionPublication) {
            // Semantic artifacts use canonical IDs, so rollout from the older
            // deterministic compiler can otherwise leave two active summaries
            // for one source. Stale source-owned summaries and publish the new
            // canonical summary in the same transaction.
            await runKnowledgeCompilationOperation(
              'import.retire_source_artifacts',
              () =>
                this.capsuleRepo.markSourceArtifactsStaleBySourcePageIds(
                  {
                    workspaceId: input.input.workspaceId,
                    spaceId: input.input.spaceId,
                    sourcePageIds: [contributionPublication.sourcePageId],
                  },
                  trx,
                ),
            );
            await runKnowledgeCompilationOperation(
              'import.replace_contributions',
              () =>
                this.contributionRepo.replaceSourceContributions(
                  {
                    workspaceId: input.input.workspaceId,
                    spaceId: input.input.spaceId,
                    sourcePageId: contributionPublication.sourcePageId,
                    contributions: contributionPublication.contributions,
                  },
                  trx,
                ),
            );
            await runKnowledgeCompilationOperation(
              'import.retire_artifacts',
              () =>
                this.capsuleRepo.markArtifactsStaleByIds(
                  {
                    workspaceId: input.input.workspaceId,
                    artifactIds: contributionPublication.removedArtifactIds,
                  },
                  trx,
                ),
            );
          } else if (input.retireSources) {
            await runKnowledgeCompilationOperation(
              'import.retire_source_artifacts',
              () =>
                this.capsuleRepo.markSourceArtifactsStaleBySourcePageIds(
                  {
                    workspaceId: input.input.workspaceId,
                    spaceId: input.input.spaceId,
                    sourcePageIds: uniqueSourcePageIds(input.input),
                  },
                  trx,
                ),
            );
          } else if (artifactInputs.length > 0) {
            await runKnowledgeCompilationOperation(
              'import.retire_source_artifacts',
              () =>
                this.capsuleRepo.markSourceArtifactsStaleBySourcePageIds(
                  {
                    workspaceId: input.input.workspaceId,
                    spaceId: input.input.spaceId,
                    sourcePageIds: uniqueSourcePageIds(input.input),
                  },
                  trx,
                ),
            );
          }

          if (quarantineInputs.length > 0) {
            await runKnowledgeCompilationOperation('import.quarantine', () =>
              this.quarantineRepo.recordQuarantinedArtifacts(
                {
                  workspaceId: input.input.workspaceId,
                  spaceId: input.input.spaceId,
                  artifacts: quarantineInputs,
                },
                trx,
              ),
            );
          }

          if (artifactInputs.length > 0) {
            await runKnowledgeCompilationOperation(
              'import.upsert_artifacts',
              () =>
                this.capsuleRepo.upsertCompiledArtifacts(artifactInputs, trx),
            );
          }

          operationBudget.throwIfAborted();
          await input.publicationComplete?.(trx);
        }),
      );
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
      quarantinedArtifactCount: validation.quarantined.length,
      embedding: embeddingStats,
      ...(largestSharedArtifact ? { largestSharedArtifact } : {}),
      ...(degradedRetrievalProfiles.length > 0
        ? {
            degradedRetrievalProfiles: [
              ...new Set(degradedRetrievalProfiles),
            ].sort(),
          }
        : {}),
    };
  }

  /**
   * Embeds the chunks about to be published, reusing stored vectors whose
   * chunk id (which hashes the exact embedding input) is unchanged.
   *
   * The current embedding profile includes the output dimensions, which only a
   * real provider response reveals, so it is never derived from configuration.
   * Chunks without a stored candidate are embedded first; when every chunk has
   * a candidate, the first one is re-embedded to learn the profile and its
   * vector is used as its result. Only candidates whose profile equals that
   * response profile are reused; the rest are embedded in a second pass. All
   * responses in one publication must share a profile, otherwise the whole
   * publication fails retryably instead of storing mixed profiles.
   */
  private async embedArtifactChunks(
    artifacts: CompiledKnowledgeArtifact[],
    identitiesByArtifactId: Map<string, ChunkIdentity[]>,
    operationBudget: KnowledgeOperationBudget,
  ): Promise<{
    chunksByArtifactId: Map<string, EmbeddedArtifactChunk[]>;
    stats: KnowledgeEmbeddingReuseStats;
  }> {
    const entries = artifacts.flatMap((artifact) =>
      (artifact.chunks ?? []).map((chunk, index) => ({
        artifactId: artifact.artifactId,
        compilerVersion: artifact.compilerVersion,
        chunk,
        index,
        chunkId: identitiesByArtifactId.get(artifact.artifactId)![index].id,
      })),
    );
    const stats: KnowledgeEmbeddingReuseStats = {
      reusedCount: 0,
      generatedCount: 0,
      profileMismatchCount: 0,
    };
    const resolved = new Map<number, KnowledgeEmbedding>();
    const pendingIndexes: number[] = [];

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const supplied = compilerEmbedding(
        entry.chunk.embedding,
        entry.compilerVersion,
      );
      if (supplied) {
        resolved.set(index, supplied);
        continue;
      }
      pendingIndexes.push(index);
    }

    const storedById = new Map(
      pendingIndexes.length > 0 &&
        typeof this.capsuleRepo.findChunkEmbeddingsByIds === 'function'
        ? (
            await this.capsuleRepo.findChunkEmbeddingsByIds({
              workspaceId: artifacts[0].workspaceId,
              chunkIds: pendingIndexes.map((index) => entries[index].chunkId),
            })
          ).map((row) => [row.id, row])
        : [],
    );
    const withCandidate = pendingIndexes.filter((index) =>
      storedById.has(entries[index].chunkId),
    );
    const firstPass = pendingIndexes.filter(
      (index) => !storedById.has(entries[index].chunkId),
    );
    if (firstPass.length === 0 && withCandidate.length > 0) {
      firstPass.push(withCandidate.shift()!);
    }

    let currentProfile: string | null = null;
    const embedPending = async (indexes: number[]) => {
      if (indexes.length === 0) return;
      const generated = await this.embedIndexes(
        entries,
        indexes,
        operationBudget,
      );
      indexes.forEach((entryIndex, index) => {
        const embedding = generated[index];
        if (currentProfile === null) currentProfile = embedding.profile;
        if (embedding.profile !== currentProfile) {
          throw new KnowledgeEmbeddingError(
            'embedding_provider_error',
            'Knowledge embedding profile changed during one publication.',
            true,
          );
        }
        resolved.set(entryIndex, embedding);
      });
      stats.generatedCount += indexes.length;
    };

    await embedPending(firstPass);

    const secondPass: number[] = [];
    for (const index of withCandidate) {
      const stored = storedById.get(entries[index].chunkId)!;
      if (
        currentProfile !== null &&
        stored.embeddingProfile === currentProfile &&
        stored.embedding.length === stored.embeddingDimensions
      ) {
        resolved.set(index, {
          vector: stored.embedding,
          profile: stored.embeddingProfile,
          model: stored.embeddingModel ?? '',
          dimensions: stored.embeddingDimensions,
          ...(stored.embeddingTotalTokens !== null
            ? { totalTokens: stored.embeddingTotalTokens }
            : {}),
          ...(stored.embeddingDurationMs !== null
            ? { durationMs: stored.embeddingDurationMs }
            : {}),
        });
        stats.reusedCount += 1;
        continue;
      }
      secondPass.push(index);
    }
    stats.profileMismatchCount = secondPass.length;
    await embedPending(secondPass);

    const result = new Map<string, EmbeddedArtifactChunk[]>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const embedding = resolved.get(index);
      if (!embedding) {
        throw new KnowledgeEmbeddingError(
          'embedding_invalid_vector',
          'Knowledge embedding provider did not return every required vector.',
          true,
        );
      }
      const chunks = result.get(entry.artifactId) ?? [];
      chunks[entry.index] = { ...entry.chunk, embedding };
      result.set(entry.artifactId, chunks);
    }
    return { chunksByArtifactId: result, stats };
  }

  private async embedIndexes(
    entries: Array<{ chunk: ArtifactChunk }>,
    indexes: number[],
    operationBudget: KnowledgeOperationBudget,
  ): Promise<KnowledgeEmbedding[]> {
    const batches = Array.from(
      { length: Math.ceil(indexes.length / KNOWLEDGE_EMBEDDING_BATCH_SIZE) },
      (_, index) =>
        indexes.slice(
          index * KNOWLEDGE_EMBEDDING_BATCH_SIZE,
          (index + 1) * KNOWLEDGE_EMBEDDING_BATCH_SIZE,
        ),
    );
    const embeddedBatches = await mapKnowledgeOperations(
      batches,
      (batch) =>
        this.embedManyRequired(
          batch.map(
            (index) =>
              entries[index].chunk.embeddingText ?? entries[index].chunk.text,
          ),
          operationBudget.signal,
        ),
      { batchSize: 20, concurrency: 2 },
    );
    const generated = embeddedBatches.flat();
    if (generated.length !== indexes.length) {
      throw new KnowledgeEmbeddingError(
        'embedding_invalid_vector',
        'Knowledge embedding provider returned an unexpected batch size.',
        true,
      );
    }
    return generated;
  }

  private async embedManyRequired(
    texts: string[],
    abortSignal?: AbortSignal,
  ): Promise<KnowledgeEmbedding[]> {
    if (typeof this.embeddingProvider.embedManyRequired === 'function') {
      return abortSignal
        ? this.embeddingProvider.embedManyRequired(texts, { abortSignal })
        : this.embeddingProvider.embedManyRequired(texts);
    }

    // Compatibility for tests/custom providers during rollout. Production has
    // embedManyRequired and therefore sends a real multi-value provider call.
    return mapKnowledgeOperations(
      texts,
      (text) => this.embedRequired(text, abortSignal),
      { batchSize: 100, concurrency: 2 },
    );
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

function assertPublicationChunkBudgets(
  budget: KnowledgeOperationBudget,
  artifacts: CompiledKnowledgeArtifact[],
): void {
  let regularChunkCount = 0;
  let tableRowCount = 0;

  for (const artifact of artifacts) {
    for (const chunk of artifact.chunks ?? []) {
      if (isTableRowChunk(chunk)) tableRowCount += 1;
      else regularChunkCount += 1;
    }
  }

  // Row-level table chunks are intentional: whole-table embeddings had poor
  // recall. They receive a larger but still hard budget instead of allowing a
  // table node to disable the ordinary 200-chunk guard for the entire page.
  budget.assertChunkCount(regularChunkCount);
  budget.assertTableRowCount(tableRowCount);
}

/**
 * Content identity for each chunk row. The id hashes the stable key together
 * with the exact embedding input, so reordering chunks keeps their ids, while
 * any change to text, table-row values, title or heading breadcrumb yields a
 * new id. Because the id pins the embedding input, a stored row with the same
 * id is a valid vector-reuse candidate (subject to a profile match).
 *
 * Legacy chunks without a stable key get one from their source lineage and
 * text instead of their array position; repeated identical legacy chunks are
 * told apart by occurrence order.
 */
function buildChunkIdentities(
  artifact: CompiledKnowledgeArtifact,
): ChunkIdentity[] {
  const legacyOccurrences = new Map<string, number>();
  return (artifact.chunks ?? []).map((chunk) => {
    let stableKey = chunk.stableKey;
    if (!stableKey) {
      const identity = hashContent(
        `${JSON.stringify(
          (chunk.inputSourceRefs ?? []).map(sourceRefIdentity),
        )}|${chunk.text}`,
      );
      const occurrence = (legacyOccurrences.get(identity) ?? 0) + 1;
      legacyOccurrences.set(identity, occurrence);
      stableKey = `legacy:${identity.replace('sha256:', '').slice(0, 40)}:${occurrence}`;
    }
    return {
      stableKey,
      id: stableKnowledgeUuid(
        `${artifact.artifactId}:chunk:${stableKey}:${hashContent(
          chunk.embeddingText ?? chunk.text,
        )}`,
      ),
    };
  });
}

function sourceRefIdentity(source: KnowledgeSourceRef): string {
  return [
    source.sourcePageId,
    source.sourceVersion,
    source.contentHash,
    source.sourceRange?.startOffset ?? '',
    source.sourceRange?.endOffset ?? '',
  ].join(':');
}

function assertSharedArtifactChunkBudgets(
  budget: KnowledgeOperationBudget,
  artifacts: CompiledKnowledgeArtifact[],
): KnowledgeImportResult['largestSharedArtifact'] {
  let largest: KnowledgeImportResult['largestSharedArtifact'];
  for (const artifact of artifacts) {
    let chunkCount = 0;
    let tableRowCount = 0;
    for (const chunk of artifact.chunks ?? []) {
      if (isTableRowChunk(chunk)) tableRowCount += 1;
      else chunkCount += 1;
    }
    budget.assertSharedArtifactCounts({
      artifactId: artifact.artifactId,
      canonicalKey: artifact.canonicalKey ?? null,
      chunkCount,
      tableRowCount,
    });
    if (!largest || chunkCount > largest.chunkCount) {
      largest = {
        artifactId: artifact.artifactId,
        canonicalKey: artifact.canonicalKey ?? null,
        chunkCount,
      };
    }
  }
  return largest;
}

function isTableRowChunk(chunk: ArtifactChunk): boolean {
  return chunk.stableKey?.startsWith('table-row:') === true;
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
  ['cross-space references must be opaque', 'cross_space_reference_not_opaque'],
  ['link lineage is incomplete', 'link_lineage_incomplete'],
  ['link source is not in compile input', 'link_source_outside_compile_input'],
  ['link source range is invalid', 'link_source_range_invalid'],
  ['link quote hash does not match source range', 'link_quote_hash_mismatch'],
  [
    'chunk attachment occurrence is not backed by a deterministic source block',
    'chunk_attachment_occurrence_unverifiable',
  ],
  [
    'chunk attachment occurrence does not match source snapshot',
    'chunk_attachment_occurrence_snapshot_mismatch',
  ],
]);

function toQuarantineReasonCodes(reasons: string[]): string[] {
  const codes = reasons.map(
    (reason) => QUARANTINE_REASON_CODES.get(reason) ?? 'validation_failed',
  );

  return Array.from(new Set(codes.length > 0 ? codes : ['validation_failed']));
}
