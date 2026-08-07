import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { JsonValue } from '@akasha/db/types/db';
import {
  KnowledgeCompilationAttempt,
  KnowledgeSourceAnalysis,
} from '@akasha/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { dbOrTx, executeTx } from '@akasha/db/utils';

export type KnowledgeCompilationStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export type KnowledgeCompilationStage =
  | 'queued'
  | 'read_source'
  | 'image_enrichment'
  | 'analysis'
  | 'generation'
  | 'merge'
  | 'validation'
  | 'embedding'
  | 'import'
  | 'completed';

type CompilationIdentity = {
  workspaceId: string;
  sourcePageId: string;
};

type FencedCompilationIdentity = CompilationIdentity & {
  compileTaskId: string;
};

type CompilationAttemptInput = CompilationIdentity & {
  spaceId: string;
  sourceVersion?: string;
  sourceContentHash?: string;
  effectiveKnowledgeHash?: string;
  compilerVersion: string;
  promptVersion: string;
  compilerRunId: string;
  compileTaskId: string;
};

type AnalysisCacheKey = CompilationIdentity & {
  effectiveKnowledgeHash: string;
  compilerVersion: string;
  promptVersion: string;
};

export type KnowledgeCompilerCandidateStage = 'analysis' | 'generation';

@Injectable()
export class KnowledgeCompilationRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async queueAttempt(
    input: CompilationAttemptInput,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const now = new Date();
    await dbOrTx(this.db, trx)
      .insertInto('knowledgeCompilationAttempts')
      .values({
        ...input,
        sourceVersion: input.sourceVersion ?? null,
        sourceContentHash: input.sourceContentHash ?? null,
        effectiveKnowledgeHash: input.effectiveKnowledgeHash ?? null,
        status: 'queued',
        stage: 'queued',
        attemptCount: 0,
        errorCode: null,
        errorMessage: null,
        queuedAt: now,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      })
      .onConflict((oc) =>
        oc.columns(['workspaceId', 'sourcePageId']).doUpdateSet({
          spaceId: input.spaceId,
          sourceVersion: input.sourceVersion ?? null,
          sourceContentHash: input.sourceContentHash ?? null,
          effectiveKnowledgeHash: input.effectiveKnowledgeHash ?? null,
          compilerVersion: input.compilerVersion,
          promptVersion: input.promptVersion,
          compilerRunId: input.compilerRunId,
          compileTaskId: input.compileTaskId,
          status: 'queued',
          stage: 'queued',
          // attemptCount is cumulative worker starts; enqueueing does not
          // represent an execution and deliberately leaves it unchanged.
          errorCode: null,
          errorMessage: null,
          queuedAt: now,
          startedAt: null,
          finishedAt: null,
          updatedAt: now,
        }),
      )
      .execute();
  }

  async startAttempt(
    input: CompilationAttemptInput,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const now = new Date();
    await dbOrTx(this.db, trx)
      .insertInto('knowledgeCompilationAttempts')
      .values({
        ...input,
        sourceVersion: input.sourceVersion ?? null,
        sourceContentHash: input.sourceContentHash ?? null,
        effectiveKnowledgeHash: input.effectiveKnowledgeHash ?? null,
        status: 'running',
        stage: 'read_source',
        attemptCount: 1,
        errorCode: null,
        errorMessage: null,
        queuedAt: now,
        startedAt: now,
        finishedAt: null,
        updatedAt: now,
      })
      .onConflict((oc) =>
        oc
          .columns(['workspaceId', 'sourcePageId'])
          .doUpdateSet({
            spaceId: input.spaceId,
            sourceVersion: input.sourceVersion ?? null,
            sourceContentHash: input.sourceContentHash ?? null,
            effectiveKnowledgeHash: input.effectiveKnowledgeHash ?? null,
            compilerVersion: input.compilerVersion,
            promptVersion: input.promptVersion,
            compilerRunId: input.compilerRunId,
            compileTaskId: input.compileTaskId,
            status: 'running',
            stage: 'read_source',
            attemptCount: sql<number>`knowledge_compilation_attempts.attempt_count + 1`,
            errorCode: null,
            errorMessage: null,
            startedAt: now,
            finishedAt: null,
            updatedAt: now,
          })
          .where((eb) =>
            eb.or([
              eb(
                'knowledgeCompilationAttempts.compileTaskId',
                '=',
                input.compileTaskId,
              ),
              eb('knowledgeCompilationAttempts.status', 'in', [
                'queued',
                'skipped',
                'failed',
                'succeeded',
              ]),
            ]),
          ),
      )
      .execute();
  }

  async updateSourceSnapshot(
    input: FencedCompilationIdentity & {
      sourceVersion: string;
      sourceContentHash: string;
      effectiveKnowledgeHash?: string;
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    await dbOrTx(this.db, trx)
      .updateTable('knowledgeCompilationAttempts')
      .set({
        sourceVersion: input.sourceVersion,
        sourceContentHash: input.sourceContentHash,
        ...(input.effectiveKnowledgeHash
          ? { effectiveKnowledgeHash: input.effectiveKnowledgeHash }
          : {}),
        updatedAt: new Date(),
      })
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .where('compileTaskId', '=', input.compileTaskId)
      .execute();
  }

  async updateStage(
    input: FencedCompilationIdentity & { stage: KnowledgeCompilationStage },
    trx?: KyselyTransaction,
  ): Promise<void> {
    await dbOrTx(this.db, trx)
      .updateTable('knowledgeCompilationAttempts')
      .set({ stage: input.stage, updatedAt: new Date() })
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .where('compileTaskId', '=', input.compileTaskId)
      .execute();
  }

  async recordCompilerCandidates(
    input: FencedCompilationIdentity & {
      stage: KnowledgeCompilerCandidateStage;
      compilerModel: string;
      compilerProfile: string;
      candidateIds: string[];
      candidateHash: string;
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    const stageValues =
      input.stage === 'analysis'
        ? {
            analysisCandidateIds: input.candidateIds as JsonValue,
            analysisCandidateHash: input.candidateHash,
          }
        : {
            generationCandidateIds: input.candidateIds as JsonValue,
            generationCandidateHash: input.candidateHash,
          };
    await dbOrTx(this.db, trx)
      .updateTable('knowledgeCompilationAttempts')
      .set({
        compilerModel: input.compilerModel,
        compilerProfile: input.compilerProfile,
        ...stageValues,
        updatedAt: new Date(),
      })
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .where('compileTaskId', '=', input.compileTaskId)
      .execute();
  }

  async reserveGenerationAttempt(
    input: FencedCompilationIdentity & {
      sourceContentHash: string;
      reset: boolean;
    },
    trx?: KyselyTransaction,
  ): Promise<{ allowed: boolean; attemptCount: number }> {
    return this.resolveGenerationAttemptBudget(input, true, trx);
  }

  async checkGenerationAttemptBudget(
    input: FencedCompilationIdentity & {
      sourceContentHash: string;
      reset: boolean;
    },
    trx?: KyselyTransaction,
  ): Promise<{ allowed: boolean; attemptCount: number }> {
    return this.resolveGenerationAttemptBudget(input, false, trx);
  }

  private async resolveGenerationAttemptBudget(
    input: FencedCompilationIdentity & {
      sourceContentHash: string;
      reset: boolean;
    },
    consume: boolean,
    trx?: KyselyTransaction,
  ): Promise<{ allowed: boolean; attemptCount: number }> {
    const resolve = async (db: KyselyTransaction) => {
      // Different page-scoped Runs create different compileTaskIds. Serialize
      // by page and carry the newest count forward so retries cannot reset the
      // three-attempt budget merely by creating another attempt row.
      await sql`
        SELECT pg_advisory_xact_lock(
          hashtext(${`${input.workspaceId}:${input.sourcePageId}`})
        )
      `.execute(db);
      const currentAttempt = await db
        .selectFrom('knowledgeCompilationAttempts')
        .select(['generationAttemptSourceHash', 'generationAttemptCount'])
        .where('workspaceId', '=', input.workspaceId)
        .where('sourcePageId', '=', input.sourcePageId)
        .where('compileTaskId', '=', input.compileTaskId)
        .executeTakeFirst();
      const startsForcedRound =
        input.reset &&
        (currentAttempt?.generationAttemptSourceHash !==
          input.sourceContentHash ||
          currentAttempt.generationAttemptCount === 0);
      const previous = startsForcedRound
        ? undefined
        : await db
            .selectFrom('knowledgeCompilationAttempts')
            .select('generationAttemptCount')
            .where('workspaceId', '=', input.workspaceId)
            .where('sourcePageId', '=', input.sourcePageId)
            .where('generationAttemptSourceHash', '=', input.sourceContentHash)
            .orderBy('updatedAt', 'desc')
            .orderBy('id', 'desc')
            .limit(1)
            .executeTakeFirst();
      const previousCount = previous?.generationAttemptCount ?? 0;
      if (!startsForcedRound && previousCount >= 3) {
        return { allowed: false, attemptCount: previousCount };
      }
      if (!consume) {
        return { allowed: true, attemptCount: previousCount };
      }
      const attemptCount = startsForcedRound ? 1 : previousCount + 1;
      const row = await db
        .updateTable('knowledgeCompilationAttempts')
        .set({
          generationAttemptSourceHash: input.sourceContentHash,
          generationAttemptCount: attemptCount,
          updatedAt: new Date(),
        })
        .where('workspaceId', '=', input.workspaceId)
        .where('sourcePageId', '=', input.sourcePageId)
        .where('compileTaskId', '=', input.compileTaskId)
        .returning('id')
        .executeTakeFirst();
      return row
        ? { allowed: true, attemptCount }
        : { allowed: false, attemptCount };
    };
    return trx ? resolve(trx) : executeTx(this.db, resolve);
  }

  async markResultQuality(
    input: FencedCompilationIdentity & {
      quality: 'normal' | 'degraded' | 'partial_image';
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    await dbOrTx(this.db, trx)
      .updateTable('knowledgeCompilationAttempts')
      .set({ resultQuality: input.quality, updatedAt: new Date() })
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .where('compileTaskId', '=', input.compileTaskId)
      .execute();
  }

  async hasLastSuccessfulPublication(input: {
    workspaceId: string;
    spaceId: string;
    sourcePageId: string;
  }): Promise<boolean> {
    const row = await this.db
      .selectFrom('knowledgeCompilationAttempts as attempt')
      .innerJoin('knowledgeArtifactContributions as contribution', (join) =>
        join
          .onRef('contribution.workspaceId', '=', 'attempt.workspaceId')
          .onRef('contribution.sourcePageId', '=', 'attempt.sourcePageId')
          .on('contribution.spaceId', '=', input.spaceId)
          .on('contribution.artifactKind', '=', 'source_summary'),
      )
      .innerJoin('knowledgePages as page', (join) =>
        join
          .onRef('page.id', '=', 'contribution.artifactId')
          .onRef('page.workspaceId', '=', 'attempt.workspaceId')
          .on('page.spaceId', '=', input.spaceId)
          .on('page.staleAt', 'is', null),
      )
      .select('attempt.id')
      .where('attempt.workspaceId', '=', input.workspaceId)
      .where('attempt.spaceId', '=', input.spaceId)
      .where('attempt.sourcePageId', '=', input.sourcePageId)
      .where('attempt.lastSucceededAt', 'is not', null)
      .limit(1)
      .executeTakeFirst();
    return Boolean(row);
  }

  async failAttempt(
    input: FencedCompilationIdentity & {
      stage?: KnowledgeCompilationStage;
      errorCode: string;
      errorMessage: string;
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    const now = new Date();
    await dbOrTx(this.db, trx)
      .updateTable('knowledgeCompilationAttempts')
      .set({
        status: 'failed',
        ...(input.stage ? { stage: input.stage } : {}),
        errorCode: sanitizeErrorCode(input.errorCode),
        errorMessage: sanitizeErrorMessage(input.errorMessage),
        finishedAt: now,
        updatedAt: now,
      })
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .where('compileTaskId', '=', input.compileTaskId)
      .execute();
  }

  async savePendingImport(
    input: FencedCompilationIdentity & {
      spaceId: string;
      sourceVersion: string;
      effectiveKnowledgeHash: string;
      preparedImport: JsonValue;
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    await dbOrTx(this.db, trx)
      .updateTable('knowledgeCompilationAttempts')
      .set({
        pendingImport: input.preparedImport,
        pendingSpaceId: input.spaceId,
        pendingSourceVersion: input.sourceVersion,
        pendingEffectiveKnowledgeHash: input.effectiveKnowledgeHash,
        pendingCreatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .where('compileTaskId', '=', input.compileTaskId)
      .execute();
  }

  async findPendingImport(input: {
    workspaceId: string;
    sourcePageId: string;
    spaceId: string;
    sourceVersion: string;
    effectiveKnowledgeHash: string;
    compilerVersion: string;
    promptVersion: string;
  }): Promise<JsonValue | undefined> {
    const row = await this.db
      .selectFrom('knowledgeCompilationAttempts')
      .select('pendingImport')
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .where('pendingSpaceId', '=', input.spaceId)
      .where('pendingSourceVersion', '=', input.sourceVersion)
      .where('pendingEffectiveKnowledgeHash', '=', input.effectiveKnowledgeHash)
      .where('compilerVersion', '=', input.compilerVersion)
      .where('promptVersion', '=', input.promptVersion)
      .where('pendingImport', 'is not', null)
      .executeTakeFirst();
    return row?.pendingImport ?? undefined;
  }

  async skipAttempt(
    input: FencedCompilationIdentity & {
      stage?: KnowledgeCompilationStage;
      reasonCode: string;
      reasonMessage: string;
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    const now = new Date();
    await dbOrTx(this.db, trx)
      .updateTable('knowledgeCompilationAttempts')
      .set({
        status: 'skipped',
        ...(input.stage ? { stage: input.stage } : {}),
        errorCode: sanitizeErrorCode(input.reasonCode),
        errorMessage: sanitizeErrorMessage(input.reasonMessage),
        finishedAt: now,
        updatedAt: now,
      })
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .where('compileTaskId', '=', input.compileTaskId)
      .execute();
  }

  async succeedAttempt(
    input: FencedCompilationIdentity & {
      sourceVersion: string;
      sourceContentHash: string;
      effectiveKnowledgeHash?: string;
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    const now = new Date();
    await dbOrTx(this.db, trx)
      .updateTable('knowledgeCompilationAttempts')
      .set({
        status: 'succeeded',
        stage: 'completed',
        errorCode: null,
        errorMessage: null,
        pendingImport: null,
        pendingSpaceId: null,
        pendingSourceVersion: null,
        pendingEffectiveKnowledgeHash: null,
        pendingCreatedAt: null,
        lastSuccessfulSourceVersion: input.sourceVersion,
        lastSuccessfulSourceHash: input.sourceContentHash,
        effectiveKnowledgeHash: input.effectiveKnowledgeHash ?? null,
        lastSuccessfulEffectiveHash: input.effectiveKnowledgeHash ?? null,
        lastSucceededAt: now,
        finishedAt: now,
        updatedAt: now,
      })
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .where('compileTaskId', '=', input.compileTaskId)
      .execute();
  }

  async findAnalysis(
    input: AnalysisCacheKey,
    trx?: KyselyTransaction,
  ): Promise<JsonValue | undefined> {
    const row = await dbOrTx(this.db, trx)
      .selectFrom('knowledgeSourceAnalyses')
      .select('analysis')
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .where('sourceContentHash', '=', input.effectiveKnowledgeHash)
      .where('compilerVersion', '=', input.compilerVersion)
      .where('promptVersion', '=', input.promptVersion)
      .executeTakeFirst();

    return row?.analysis;
  }

  async saveAnalysis(
    input: {
      workspaceId: string;
      spaceId: string;
      sourcePageId: string;
      sourceVersion: string;
      effectiveKnowledgeHash: string;
      compilerVersion: string;
      promptVersion: string;
      analysis: JsonValue;
      publicationGuard?: (trx: KyselyTransaction) => Promise<boolean>;
    },
    trx?: KyselyTransaction,
  ): Promise<boolean> {
    return executeTx(
      this.db,
      async (writeTrx) => {
        if (
          input.publicationGuard &&
          !(await input.publicationGuard(writeTrx))
        ) {
          return false;
        }
        const now = new Date();
        await writeTrx
          .insertInto('knowledgeSourceAnalyses')
          .values({
            workspaceId: input.workspaceId,
            spaceId: input.spaceId,
            sourcePageId: input.sourcePageId,
            sourceVersion: input.sourceVersion,
            sourceContentHash: input.effectiveKnowledgeHash,
            compilerVersion: input.compilerVersion,
            promptVersion: input.promptVersion,
            analysis: input.analysis,
            updatedAt: now,
          })
          .onConflict((oc) =>
            oc
              .columns([
                'workspaceId',
                'sourcePageId',
                'sourceContentHash',
                'compilerVersion',
                'promptVersion',
              ])
              .doUpdateSet({
                spaceId: input.spaceId,
                sourceVersion: input.sourceVersion,
                analysis: input.analysis,
                updatedAt: now,
              }),
          )
          .execute();
        return true;
      },
      trx,
    );
  }

  async findDiagnosticsByPageIds(input: {
    workspaceId: string;
    sourcePageIds: string[];
  }): Promise<KnowledgeCompilationAttempt[]> {
    if (input.sourcePageIds.length === 0) return [];

    return this.db
      .selectFrom('knowledgeCompilationAttempts')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', 'in', input.sourcePageIds)
      .orderBy('updatedAt', 'desc')
      .execute();
  }

  /**
   * Reads the last published page identity in one Space-scoped query. A row is
   * returned only when the successful attempt still has its exact active
   * source, semantic contribution, source-summary page, and searchable chunk.
   * The current attempt status is intentionally informational: a later failed
   * retry must not erase a still-valid successful publication.
   */
  async findSpaceReuseCandidates(input: {
    workspaceId: string;
    spaceId: string;
    sourcePageIds: string[];
  }) {
    if (input.sourcePageIds.length === 0) return [];

    return this.db
      .selectFrom('knowledgeCompilationAttempts as attempt')
      .innerJoin('knowledgeSources as source', (join) =>
        join
          .onRef('source.workspaceId', '=', 'attempt.workspaceId')
          .onRef('source.sourcePageId', '=', 'attempt.sourcePageId')
          .onRef(
            'source.sourceVersion',
            '=',
            'attempt.lastSuccessfulSourceVersion',
          )
          .onRef('source.contentHash', '=', 'attempt.lastSuccessfulSourceHash')
          .on('source.sourceSpaceId', '=', input.spaceId)
          .on('source.staleAt', 'is', null)
          .on('source.deletedAt', 'is', null),
      )
      .innerJoin('knowledgeArtifactContributions as contribution', (join) =>
        join
          .onRef('contribution.workspaceId', '=', 'attempt.workspaceId')
          .onRef('contribution.sourcePageId', '=', 'attempt.sourcePageId')
          .onRef(
            'contribution.sourceVersion',
            '=',
            'attempt.lastSuccessfulSourceVersion',
          )
          .onRef(
            'contribution.sourceContentHash',
            '=',
            'attempt.lastSuccessfulSourceHash',
          )
          .on('contribution.spaceId', '=', input.spaceId)
          .on('contribution.artifactKind', '=', 'source_summary'),
      )
      .innerJoin('knowledgePages as summary', (join) =>
        join
          .onRef('summary.id', '=', 'contribution.artifactId')
          .onRef('summary.workspaceId', '=', 'attempt.workspaceId')
          .on('summary.spaceId', '=', input.spaceId)
          .on('summary.pageType', '=', 'source_summary')
          .on('summary.staleAt', 'is', null),
      )
      .innerJoin('knowledgeChunks as summaryChunk', (join) =>
        join
          .onRef('summaryChunk.knowledgePageId', '=', 'summary.id')
          .onRef('summaryChunk.workspaceId', '=', 'attempt.workspaceId')
          .on('summaryChunk.staleAt', 'is', null)
          .on('summaryChunk.retrievalChannel', '=', 'evidence'),
      )
      .select([
        'attempt.sourcePageId',
        'attempt.status',
        'attempt.lastSuccessfulSourceVersion',
        'attempt.lastSuccessfulSourceHash',
        'attempt.lastSuccessfulEffectiveHash',
        'source.id as activeSourceId',
        'summary.id as activeSummaryId',
        'summaryChunk.id as activeSummaryChunkId',
        'contribution.sourceVersion as contributionSourceVersion',
        'contribution.sourceContentHash as contributionSourceHash',
        'contribution.compilerVersion as contributionCompilerVersion',
        'contribution.promptVersion as contributionPromptVersion',
      ])
      .distinctOn('attempt.sourcePageId')
      .where('attempt.workspaceId', '=', input.workspaceId)
      .where('attempt.spaceId', '=', input.spaceId)
      .where('attempt.sourcePageId', 'in', input.sourcePageIds)
      .where('attempt.lastSuccessfulSourceVersion', 'is not', null)
      .where('attempt.lastSuccessfulSourceHash', 'is not', null)
      .where('attempt.lastSuccessfulEffectiveHash', 'is not', null)
      .orderBy('attempt.sourcePageId', 'asc')
      .orderBy('contribution.updatedAt', 'desc')
      .execute();
  }
}

function sanitizeErrorCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
  return normalized.slice(0, 80) || 'compile_failed';
}

function sanitizeErrorMessage(value: string): string {
  return replaceControlCharacters(value).trim().slice(0, 500);
}

function replaceControlCharacters(value: string): string {
  let normalized = '';
  let replacingControlSequence = false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const isControl = code <= 0x1f || code === 0x7f;
    if (isControl) {
      if (!replacingControlSequence) normalized += ' ';
      replacingControlSequence = true;
    } else {
      normalized += character;
      replacingControlSequence = false;
    }
  }
  return normalized;
}
