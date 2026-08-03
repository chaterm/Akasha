import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KnowledgeImageExtraction } from '@akasha/db/types/entity.types';
import { KyselyDB } from '@akasha/db/types/kysely.types';

export type KnowledgeImageExtractionCacheKey = {
  workspaceId: string;
  attachmentId: string;
  attachmentVersion: Date;
  cacheFingerprint: string;
  contentHash: string;
  model: string;
  promptVersion: string;
};

export type KnowledgeImageExtractionClaim =
  | {
      state: 'claimed';
      extraction: KnowledgeImageExtraction;
      leaseToken: string;
    }
  | {
      state: 'ready';
      extraction: KnowledgeImageExtraction;
    }
  | {
      state: 'busy';
      extraction: KnowledgeImageExtraction;
    }
  | {
      state: 'failed';
      extraction: KnowledgeImageExtraction;
    };

export type KnowledgeImageExtractionSuccessInput = {
  extractionId: string;
  leaseToken: string;
  ocrText: string;
  caption: string;
  mimeType: string;
  fileName?: string | null;
};

export type KnowledgeImageExtractionFailureInput = {
  extractionId: string;
  leaseToken: string;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
  retryAfter?: Date | null;
};

export type CurrentReadyKnowledgeImageExtraction = KnowledgeImageExtraction & {
  attachmentVersion: Date | null;
  currentAttachmentVersion: Date;
  attachmentWorkspaceId: string;
  attachmentSpaceId: string | null;
  attachmentPageId: string | null;
};

const CACHE_KEY_COLUMNS = [
  'workspaceId',
  'attachmentId',
  'cacheFingerprint',
] as const;
const SNAPSHOT_IMAGE_LOOKUP_BATCH_SIZE = 1_000;

@Injectable()
export class KnowledgeImageExtractionRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findCached(
    input: Pick<
      KnowledgeImageExtractionCacheKey,
      'workspaceId' | 'attachmentId' | 'cacheFingerprint'
    >,
  ): Promise<KnowledgeImageExtraction | undefined> {
    return this.db
      .selectFrom('knowledgeImageExtractions')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('attachmentId', '=', input.attachmentId)
      .where('cacheFingerprint', '=', input.cacheFingerprint)
      .executeTakeFirst();
  }

  async findCurrentReadyForSnapshotImages(input: {
    workspaceId: string;
    spaceId: string;
    images: Array<{
      sourcePageId: string;
      attachmentId: string;
      attachmentVersion: string;
    }>;
    model: string;
    promptVersion: string;
  }): Promise<CurrentReadyKnowledgeImageExtraction[]> {
    if (input.images.length === 0) return [];
    const attachmentIds = [
      ...new Set(input.images.map((image) => image.attachmentId)),
    ];
    const expectedOwnership = new Map(
      input.images.map((image) => [
        image.attachmentId,
        `${image.sourcePageId}\u001f${image.attachmentVersion}`,
      ]),
    );

    const rows: CurrentReadyKnowledgeImageExtraction[] = [];
    for (const attachmentIdBatch of batches(
      attachmentIds,
      SNAPSHOT_IMAGE_LOOKUP_BATCH_SIZE,
    )) {
      rows.push(
        ...(await this.db
          .selectFrom('knowledgeImageExtractions as extraction')
          .innerJoin(
            'attachments as attachment',
            'attachment.id',
            'extraction.attachmentId',
          )
          .selectAll('extraction')
          .select([
            'attachment.updatedAt as currentAttachmentVersion',
            'attachment.workspaceId as attachmentWorkspaceId',
            'attachment.spaceId as attachmentSpaceId',
            'attachment.pageId as attachmentPageId',
          ])
          .distinctOn('extraction.attachmentId')
          .where('extraction.workspaceId', '=', input.workspaceId)
          .where('extraction.attachmentId', 'in', attachmentIdBatch)
          .where('extraction.status', '=', 'ready')
          .where('extraction.model', '=', input.model)
          .where('extraction.promptVersion', '=', input.promptVersion)
          .where('extraction.cacheFingerprint', '!=', '')
          .where('extraction.contentHash', '!=', '')
          .where('attachment.workspaceId', '=', input.workspaceId)
          .where('attachment.spaceId', '=', input.spaceId)
          .where('attachment.deletedAt', 'is', null)
          .where('extraction.attachmentVersion', 'is not', null)
          .where(
            sql<boolean>`date_trunc('milliseconds', extraction.attachment_version) = date_trunc('milliseconds', attachment.updated_at)`,
          )
          .where(
            sql<boolean>`(
              length(trim(coalesce(extraction.ocr_text, ''))) > 0
              OR length(trim(coalesce(extraction.caption, ''))) > 0
            )`,
          )
          .orderBy('extraction.attachmentId', 'asc')
          .orderBy('extraction.updatedAt', 'desc')
          .orderBy('extraction.id', 'desc')
          .execute()),
      );
    }
    return rows.filter((row) => {
      const expected = expectedOwnership.get(row.attachmentId);
      return (
        expected ===
          `${row.attachmentPageId ?? ''}\u001f${row.currentAttachmentVersion.toISOString()}` &&
        row.attachmentVersion?.toISOString() ===
          row.currentAttachmentVersion.toISOString() &&
        row.status === 'ready' &&
        row.model === input.model &&
        row.promptVersion === input.promptVersion &&
        Boolean(row.cacheFingerprint.trim()) &&
        Boolean(row.contentHash.trim()) &&
        Boolean(row.ocrText?.trim() || row.caption?.trim())
      );
    });
  }

  /**
   * Atomically claims a cache key. Only the lease owner may publish a result.
   * A crashed worker can be replaced after its lease expires, and retryable
   * failures can be reclaimed only after their shared database backoff.
   */
  async claim(
    input: KnowledgeImageExtractionCacheKey,
    leaseMs: number,
  ): Promise<KnowledgeImageExtractionClaim> {
    const leaseToken = randomUUID();
    const leaseExpiresAt = sql<Date>`now() + (${leaseMs} * interval '1 millisecond')`;
    const updatedAt = new Date();

    // The caller has already re-read and validated ownership plus image bytes.
    // Refresh the durable attachment version before reusing an otherwise
    // identical ready cache entry.
    const validatedReady = await this.db
      .updateTable('knowledgeImageExtractions')
      .set({
        attachmentVersion: input.attachmentVersion,
        updatedAt,
      })
      .where('workspaceId', '=', input.workspaceId)
      .where('attachmentId', '=', input.attachmentId)
      .where('cacheFingerprint', '=', input.cacheFingerprint)
      .where('status', '=', 'ready')
      .where('contentHash', '=', input.contentHash)
      .where('model', '=', input.model)
      .where('promptVersion', '=', input.promptVersion)
      .returningAll()
      .executeTakeFirst();
    if (validatedReady) {
      return { state: 'ready', extraction: validatedReady };
    }

    const claimed = await this.db
      .insertInto('knowledgeImageExtractions')
      .values({
        ...input,
        status: 'processing',
        mimeType: null,
        fileName: null,
        ocrText: null,
        caption: null,
        errorCode: null,
        errorMessage: null,
        leaseToken,
        leaseExpiresAt,
        retryable: null,
        retryAfter: null,
        attemptCount: 1,
        updatedAt,
      })
      .onConflict((oc) =>
        oc
          .columns(CACHE_KEY_COLUMNS)
          .doUpdateSet({
            status: 'processing',
            mimeType: null,
            fileName: null,
            ocrText: null,
            caption: null,
            errorCode: null,
            errorMessage: null,
            leaseToken,
            leaseExpiresAt,
            retryable: null,
            retryAfter: null,
            attachmentVersion: input.attachmentVersion,
            attemptCount: sql<number>`knowledge_image_extractions.attempt_count + 1`,
            updatedAt,
          })
          .where(
            sql<boolean>`
              (
                knowledge_image_extractions.status = 'processing'
                AND knowledge_image_extractions.lease_expires_at <= now()
              )
              OR
              (
                knowledge_image_extractions.status = 'failed'
                AND knowledge_image_extractions.retryable = true
                AND knowledge_image_extractions.retry_after <= now()
              )
            `,
          ),
      )
      .returningAll()
      .executeTakeFirst();

    if (claimed?.leaseToken === leaseToken) {
      return { state: 'claimed', extraction: claimed, leaseToken };
    }

    // DO UPDATE ... WHERE returns no row when another worker owns the key or
    // when it is already terminal, so read the winning state after the write.
    const existing = await this.findCached(input);
    if (!existing) {
      // The attachment may have been deleted by the FK cascade between the two
      // statements. Treat this as busy so callers safely skip the image.
      throw new Error('Knowledge image extraction claim disappeared.');
    }
    if (existing.status === 'ready') {
      return { state: 'ready', extraction: existing };
    }
    if (existing.status === 'failed') {
      return { state: 'failed', extraction: existing };
    }
    return { state: 'busy', extraction: existing };
  }

  async completeSuccess(
    input: KnowledgeImageExtractionSuccessInput,
  ): Promise<KnowledgeImageExtraction | undefined> {
    return this.db
      .updateTable('knowledgeImageExtractions')
      .set({
        status: 'ready',
        mimeType: input.mimeType,
        fileName: input.fileName ?? null,
        ocrText: input.ocrText,
        caption: input.caption,
        errorCode: null,
        errorMessage: null,
        leaseToken: null,
        leaseExpiresAt: null,
        retryable: null,
        retryAfter: null,
        updatedAt: new Date(),
      })
      .where('id', '=', input.extractionId)
      .where('status', '=', 'processing')
      .where('leaseToken', '=', input.leaseToken)
      .returningAll()
      .executeTakeFirst();
  }

  async completeFailure(
    input: KnowledgeImageExtractionFailureInput,
  ): Promise<KnowledgeImageExtraction | undefined> {
    return this.db
      .updateTable('knowledgeImageExtractions')
      .set({
        status: 'failed',
        mimeType: null,
        fileName: null,
        ocrText: null,
        caption: null,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        leaseToken: null,
        leaseExpiresAt: null,
        retryable: input.retryable,
        retryAfter: input.retryable ? (input.retryAfter ?? new Date()) : null,
        updatedAt: new Date(),
      })
      .where('id', '=', input.extractionId)
      .where('status', '=', 'processing')
      .where('leaseToken', '=', input.leaseToken)
      .returningAll()
      .executeTakeFirst();
  }
}

function batches<T>(values: readonly T[], batchSize: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    result.push(values.slice(offset, offset + batchSize));
  }
  return result;
}
