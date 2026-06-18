import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { dbOrTx } from '@docmost/db/utils';
import { JsonValue } from '@docmost/db/types/db';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';

export type KnowledgeQuarantinedArtifactRecord = {
  artifactId?: string | null;
  artifactKind?: string | null;
  compilerRunId?: string | null;
  compileTaskId?: string | null;
  reasonCodes: string[];
};

export type KnowledgeQuarantinedArtifactDiagnostic = {
  id: string;
  workspaceId: string;
  spaceId: string;
  artifactId: string | null;
  artifactKind: string | null;
  compilerRunId: string | null;
  compileTaskId: string | null;
  reasonCodes: string[];
  createdAt: Date;
};

@Injectable()
export class KnowledgeQuarantineRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async recordQuarantinedArtifacts(
    input: {
      workspaceId: string;
      spaceId: string;
      artifacts: KnowledgeQuarantinedArtifactRecord[];
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    if (input.artifacts.length === 0) return;

    await dbOrTx(this.db, trx)
      .insertInto('knowledgeQuarantinedArtifacts')
      .values(
        input.artifacts.map((artifact) => ({
          workspaceId: input.workspaceId,
          spaceId: input.spaceId,
          artifactId: artifact.artifactId ?? null,
          artifactKind: artifact.artifactKind ?? null,
          compilerRunId: artifact.compilerRunId ?? null,
          compileTaskId: artifact.compileTaskId ?? null,
          reasonCodes: normalizeReasonCodes(artifact.reasonCodes) as JsonValue,
        })),
      )
      .execute();
  }

  async findRecentByWorkspace(input: {
    workspaceId: string;
    limit?: number;
  }): Promise<KnowledgeQuarantinedArtifactDiagnostic[]> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const rows = await this.db
      .selectFrom('knowledgeQuarantinedArtifacts')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      spaceId: row.spaceId,
      artifactId: row.artifactId,
      artifactKind: row.artifactKind,
      compilerRunId: row.compilerRunId,
      compileTaskId: row.compileTaskId,
      reasonCodes: normalizeReasonCodes(row.reasonCodes),
      createdAt: row.createdAt,
    }));
  }
}

function normalizeReasonCodes(value: unknown): string[] {
  const reasonCodes = Array.isArray(value)
    ? value.filter((reason): reason is string => typeof reason === 'string')
    : [];

  return reasonCodes.length > 0 ? reasonCodes : ['validation_failed'];
}
