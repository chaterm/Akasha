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
  | 'failed';

export type KnowledgeCompilationStage =
  | 'queued'
  | 'read_source'
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

type AnalysisCacheKey = CompilationIdentity & {
  sourceContentHash: string;
  compilerVersion: string;
  promptVersion: string;
};

@Injectable()
export class KnowledgeCompilationRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async startAttempt(
    input: {
      workspaceId: string;
      spaceId: string;
      sourcePageId: string;
      sourceVersion: string;
      sourceContentHash: string;
      compilerVersion: string;
      promptVersion: string;
      compilerRunId: string;
      compileTaskId: string;
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    const now = new Date();
    await dbOrTx(this.db, trx)
      .insertInto('knowledgeCompilationAttempts')
      .values({
        ...input,
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
        oc.columns(['workspaceId', 'sourcePageId']).doUpdateSet({
          spaceId: input.spaceId,
          sourceVersion: input.sourceVersion,
          sourceContentHash: input.sourceContentHash,
          compilerVersion: input.compilerVersion,
          promptVersion: input.promptVersion,
          compilerRunId: input.compilerRunId,
          compileTaskId: input.compileTaskId,
          status: 'running',
          stage: 'read_source',
          attemptCount: sql<number>`knowledge_compilation_attempts.attempt_count + 1`,
          errorCode: null,
          errorMessage: null,
          queuedAt: now,
          startedAt: now,
          finishedAt: null,
          updatedAt: now,
        }),
      )
      .execute();
  }

  async updateStage(
    input: CompilationIdentity & { stage: KnowledgeCompilationStage },
    trx?: KyselyTransaction,
  ): Promise<void> {
    await dbOrTx(this.db, trx)
      .updateTable('knowledgeCompilationAttempts')
      .set({ stage: input.stage, updatedAt: new Date() })
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .execute();
  }

  async failAttempt(
    input: CompilationIdentity & {
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
      .execute();
  }

  async succeedAttempt(
    input: CompilationIdentity & {
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
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  return normalized.slice(0, 80) || 'compile_failed';
}

function sanitizeErrorMessage(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500);
}
