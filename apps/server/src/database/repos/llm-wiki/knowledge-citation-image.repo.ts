import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';

export type RunImageCandidate = {
  sourcePageId: string;
  attachmentId: string;
  altText: string | null;
  imageOrdinal: number;
  extractionId: string | null;
  fileName: string;
  mimeType: string;
};

type RunImageRow = RunImageCandidate & {
  runId: string;
  runFinishedAt: Date | null;
  runUpdatedAt: Date;
};

@Injectable()
export class KnowledgeCitationImageRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findCurrentPublishedRunImages(input: {
    workspaceId: string;
    sourcePageIds: string[];
  }): Promise<RunImageCandidate[]> {
    if (input.sourcePageIds.length === 0) return [];

    const rows = (await this.db
      .selectFrom('knowledgeSources as source')
      .innerJoin('spaces as space', (join) =>
        join
          .onRef('space.id', '=', 'source.sourceSpaceId')
          .onRef('space.workspaceId', '=', 'source.workspaceId'),
      )
      .innerJoin('knowledgeSpaceCompileRunPages as runPage', (join) =>
        join
          .onRef('runPage.sourcePageId', '=', 'source.sourcePageId')
          .onRef('runPage.expectedSourceVersion', '=', 'source.sourceVersion')
          .onRef('runPage.expectedSourceContentHash', '=', 'source.contentHash')
          .onRef('runPage.workspaceId', '=', 'source.workspaceId')
          .on('runPage.status', '=', 'succeeded')
          .on('runPage.mergeStatus', '=', 'succeeded'),
      )
      .innerJoin('knowledgeSpaceCompileRuns as run', (join) =>
        join
          .onRef('run.id', '=', 'runPage.runId')
          .onRef('run.spaceId', '=', 'source.sourceSpaceId')
          .onRef('run.knowledgeGeneration', '=', 'space.knowledgeGeneration')
          .on('run.status', 'in', ['succeeded', 'partial']),
      )
      .innerJoin('knowledgeSpaceCompileRunImages as image', (join) =>
        join
          .onRef('image.runPageId', '=', 'runPage.id')
          .on('image.status', '=', 'succeeded'),
      )
      .where('source.workspaceId', '=', input.workspaceId)
      .where('source.sourcePageId', 'in', input.sourcePageIds)
      .where('source.staleAt', 'is', null)
      .where('source.deletedAt', 'is', null)
      .select([
        'image.sourcePageId as sourcePageId',
        'image.attachmentId as attachmentId',
        'image.altText as altText',
        'image.imageOrdinal as imageOrdinal',
        'image.extractionId as extractionId',
        'image.fileName as fileName',
        'image.mimeType as mimeType',
        'run.id as runId',
        'run.finishedAt as runFinishedAt',
        'run.updatedAt as runUpdatedAt',
      ])
      .execute()) as RunImageRow[];

    return this.selectLatestRunImagesPerPage(rows);
  }

  private selectLatestRunImagesPerPage(
    rows: RunImageRow[],
  ): RunImageCandidate[] {
    const winningRunByPage = new Map<string, string>();
    const bestRowByPage = new Map<string, RunImageRow>();

    for (const row of rows) {
      const best = bestRowByPage.get(row.sourcePageId);
      if (best === undefined || this.isNewerRun(row, best)) {
        bestRowByPage.set(row.sourcePageId, row);
        winningRunByPage.set(row.sourcePageId, row.runId);
      }
    }

    const winningRows = rows.filter(
      (row) => winningRunByPage.get(row.sourcePageId) === row.runId,
    );

    winningRows.sort((a, b) => {
      if (a.sourcePageId !== b.sourcePageId) {
        return a.sourcePageId < b.sourcePageId ? -1 : 1;
      }
      return a.imageOrdinal - b.imageOrdinal;
    });

    const seen = new Set<string>();
    const result: RunImageCandidate[] = [];
    for (const row of winningRows) {
      const dedupeKey = `${row.sourcePageId}${row.attachmentId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      result.push({
        sourcePageId: row.sourcePageId,
        attachmentId: row.attachmentId,
        altText: row.altText,
        imageOrdinal: row.imageOrdinal,
        extractionId: row.extractionId,
        fileName: row.fileName,
        mimeType: row.mimeType,
      });
    }
    return result;
  }

  private isNewerRun(candidate: RunImageRow, current: RunImageRow): boolean {
    const candidateFinished = candidate.runFinishedAt?.getTime() ?? null;
    const currentFinished = current.runFinishedAt?.getTime() ?? null;
    if (candidateFinished !== currentFinished) {
      if (candidateFinished === null) return false;
      if (currentFinished === null) return true;
      return candidateFinished > currentFinished;
    }

    const candidateUpdated = candidate.runUpdatedAt.getTime();
    const currentUpdated = current.runUpdatedAt.getTime();
    if (candidateUpdated !== currentUpdated) {
      return candidateUpdated > currentUpdated;
    }

    return candidate.runId > current.runId;
  }

  async findExtractionCaptions(input: {
    workspaceId: string;
    extractionIds: string[];
    attachmentIds: string[];
  }): Promise<Map<string, string>> {
    const captions = new Map<string, string>();

    const extractionIds = [...new Set(input.extractionIds)];
    const attachmentIds = [...new Set(input.attachmentIds)];
    if (extractionIds.length === 0 && attachmentIds.length === 0) {
      return captions;
    }

    if (extractionIds.length > 0) {
      const rows = await this.db
        .selectFrom('knowledgeImageExtractions')
        .select(['id', 'attachmentId', 'caption'])
        .where('workspaceId', '=', input.workspaceId)
        .where('id', 'in', extractionIds)
        .where('status', '=', 'ready')
        .execute();

      for (const row of rows) {
        const caption = row.caption?.trim();
        if (caption) captions.set(row.attachmentId, caption);
      }
    }

    const pendingAttachmentIds = attachmentIds.filter(
      (attachmentId) => !captions.has(attachmentId),
    );
    if (pendingAttachmentIds.length > 0) {
      const rows = await this.db
        .selectFrom('knowledgeImageExtractions')
        .select(['attachmentId', 'caption'])
        .distinctOn('attachmentId')
        .where('workspaceId', '=', input.workspaceId)
        .where('attachmentId', 'in', pendingAttachmentIds)
        .where('status', '=', 'ready')
        .orderBy('attachmentId', 'asc')
        .orderBy('updatedAt', 'desc')
        .orderBy('id', 'desc')
        .execute();

      for (const row of rows) {
        if (captions.has(row.attachmentId)) continue;
        const caption = row.caption?.trim();
        if (caption) captions.set(row.attachmentId, caption);
      }
    }

    return captions;
  }
}
