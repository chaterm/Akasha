import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { JsonValue } from '@akasha/db/types/db';
import {
  KnowledgeCompilationAttempt,
  KnowledgeSourceAnalysis,
} from '@akasha/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { dbOrTx } from '@akasha/db/utils';

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
  compilerVersion: string;
  promptVersion: string;
  compilerRunId: string;
  compileTaskId: string;
};

type AnalysisCacheKey = CompilationIdentity & {
  sourceContentHash: string;
  compilerVersion: string;
  promptVersion: string;
};

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
          .where(
            'knowledgeCompilationAttempts.compileTaskId',
            '=',
            input.compileTaskId,
          ),
      )
      .execute();
  }

  async updateSourceSnapshot(
    input: FencedCompilationIdentity & {
      sourceVersion: string;
      sourceContentHash: string;
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    await dbOrTx(this.db, trx)
      .updateTable('knowledgeCompilationAttempts')
      .set({
        sourceVersion: input.sourceVersion,
        sourceContentHash: input.sourceContentHash,
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
        lastSuccessfulSourceVersion: input.sourceVersion,
        lastSuccessfulSourceHash: input.sourceContentHash,
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
      .where('sourceContentHash', '=', input.sourceContentHash)
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
      sourceContentHash: string;
      compilerVersion: string;
      promptVersion: string;
      analysis: JsonValue;
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    const now = new Date();
    await dbOrTx(this.db, trx)
      .insertInto('knowledgeSourceAnalyses')
      .values({ ...input, updatedAt: now })
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
            sourceVersion: input.sourceVersion,
            analysis: input.analysis,
            updatedAt: now,
          }),
      )
      .execute();
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
