import { Injectable, Logger, Optional } from '@nestjs/common';
import { Attachment } from '@akasha/db/types/entity.types';
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import {
  KnowledgeCapsuleRepo,
  KnowledgeChunkSourceRef,
} from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { TokenService } from '../../../core/auth/services/token.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { isImageAttachment } from './knowledge-attachment-image';

/** Top-level attachments only ever return the final direct-hit block files. */
export const MAX_KNOWLEDGE_QUERY_ATTACHMENTS = 5;

export type KnowledgeQueryAttachment = {
  attachmentId: string;
  sourcePageId: string;
  fileName: string;
  mimeType: string | null;
  fileSize: number | null;
  url: string;
};

/**
 * Resolves downloadable, non-image attachments that live inside the final
 * direct-hit blocks of a knowledge retrieval (§7.2). Page-level ACLs are already
 * enforced during retrieval, so this service only validates block ownership,
 * version freshness and file type before signing download URLs.
 */
@Injectable()
export class KnowledgeCitationAttachmentResolverService {
  private readonly logger = new Logger(
    KnowledgeCitationAttachmentResolverService.name,
  );

  constructor(
    private readonly attachmentRepo: AttachmentRepo,
    private readonly tokenService: TokenService,
    private readonly environmentService: EnvironmentService,
    @Optional() private readonly capsuleRepo?: KnowledgeCapsuleRepo,
  ) {}

  async resolveAttachments(input: {
    workspaceId: string;
    directHitChunkIds: string[];
  }): Promise<KnowledgeQueryAttachment[]> {
    if (input.directHitChunkIds.length === 0) return [];
    // Fail-safe: without the relation repo there is no trusted block->attachment
    // mapping, so contribute nothing rather than falling back to page scans.
    if (!this.capsuleRepo) return [];

    try {
      return await this.resolveFromHitChunks(input);
    } catch (error) {
      // Batch failure degrades to an empty attachment list; the answer is
      // unaffected (§7.2 fail-safe).
      this.logger.warn({
        event: 'knowledge_attachment_resolution_failed',
        reason: 'batch_query_failed',
        workspaceId: input.workspaceId,
        directHitChunkCount: input.directHitChunkIds.length,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return [];
    }
  }

  private async resolveFromHitChunks(input: {
    workspaceId: string;
    directHitChunkIds: string[];
  }): Promise<KnowledgeQueryAttachment[]> {
    const startedAt = Date.now();
    const capsuleRepo = this.capsuleRepo!;
    const [relationRows, sourceRefRows] = await Promise.all([
      capsuleRepo.findChunkAttachmentsByChunkIds({
        workspaceId: input.workspaceId,
        chunkIds: input.directHitChunkIds,
      }),
      capsuleRepo.findChunkSourceRefsByChunkIds({
        workspaceId: input.workspaceId,
        chunkIds: input.directHitChunkIds,
      }),
    ]);
    // §11.4 counts. Nothing here records signed tokens, URLs or file bytes.
    const metrics = {
      directHitChunkCount: input.directHitChunkIds.length,
      // A relation row is only ever written for a deterministic source block
      // (§5.3.7), never a model summary block, so this doubles as the
      // `source:`-prefixed hit-block count for diagnostics.
      chunksWithRelationCount: relationRows.filter(
        (row) => row.attachments.length > 0,
      ).length,
      chunksWithoutMappingCount: relationRows.filter(
        (row) => row.attachments.length === 0,
      ).length,
      candidateCount: 0,
      distinctCandidateCount: 0,
      validCount: 0,
      truncatedCount: 0,
      imageFilteredCount: 0,
      updatedAtMismatchCount: 0,
      ownershipFailureCount: 0,
      signFailureCount: 0,
    };

    const attachmentIds = unique(
      relationRows.flatMap((row) =>
        row.attachments.map((occurrence) => occurrence.attachmentId),
      ),
    );
    metrics.candidateCount = relationRows.reduce(
      (sum, row) => sum + row.attachments.length,
      0,
    );
    metrics.distinctCandidateCount = attachmentIds.length;
    if (attachmentIds.length === 0) {
      this.logResolution(metrics, startedAt);
      return [];
    }

    const attachments = await this.attachmentRepo.findByIds(attachmentIds);
    const attachmentById = new Map(
      attachments.map((attachment) => [attachment.id, attachment]),
    );
    const sourceRefsByChunkId = new Map(
      sourceRefRows.map((row) => [row.chunkId, row.sources]),
    );

    const resolved: KnowledgeQueryAttachment[] = [];
    const seenAttachmentIds = new Set<string>();
    // relationRows preserve directHitChunkIds order and each chunk's
    // occurrences are ordered by occurrence_order, so this expands candidates
    // by block rank then in-block position (§7.2.3).
    for (const row of relationRows) {
      for (const occurrence of row.attachments) {
        if (resolved.length >= MAX_KNOWLEDGE_QUERY_ATTACHMENTS) {
          metrics.truncatedCount += 1;
          continue;
        }
        if (seenAttachmentIds.has(occurrence.attachmentId)) continue;
        const attachment = attachmentById.get(occurrence.attachmentId);
        const reason = this.attachmentRejectReason({
          attachment,
          occurrence,
          chunkId: row.chunkId,
          workspaceId: input.workspaceId,
          sourceRefsByChunkId,
        });
        if (reason) {
          if (reason === 'image') metrics.imageFilteredCount += 1;
          else if (reason === 'updated_at') metrics.updatedAtMismatchCount += 1;
          else metrics.ownershipFailureCount += 1;
          continue;
        }
        // First-wins dedup (§7.2.6): once a valid occurrence is chosen, later
        // occurrences of the same attachment are ignored even if signing fails.
        seenAttachmentIds.add(occurrence.attachmentId);
        const built = await this.buildAttachment(
          attachment!,
          input.workspaceId,
        );
        if (built) {
          metrics.validCount += 1;
          resolved.push(built);
        } else {
          metrics.signFailureCount += 1;
        }
      }
    }
    this.logResolution(metrics, startedAt);
    return resolved;
  }

  private logResolution(
    metrics: {
      directHitChunkCount: number;
      chunksWithRelationCount: number;
      chunksWithoutMappingCount: number;
      candidateCount: number;
      distinctCandidateCount: number;
      validCount: number;
      truncatedCount: number;
      imageFilteredCount: number;
      updatedAtMismatchCount: number;
      ownershipFailureCount: number;
      signFailureCount: number;
    },
    startedAt: number,
  ): void {
    this.logger.debug({
      event: 'knowledge_attachment_resolution',
      ...metrics,
      resolveDurationMs: Date.now() - startedAt,
    });
  }

  /**
   * Validates a single occurrence against ownership, file type and the §7.2.5
   * version snapshot. Page ACLs were already enforced during retrieval. Returns
   * `null` when the occurrence is valid, otherwise a coarse reject reason used
   * for §11.4 counts (never any signed material).
   */
  private attachmentRejectReason(params: {
    attachment: Attachment | undefined;
    occurrence: {
      attachmentId: string;
      sourcePageId: string;
      sourceVersion: string;
      sourceContentHash: string;
      attachmentUpdatedAt: Date;
    };
    chunkId: string;
    workspaceId: string;
    sourceRefsByChunkId: Map<string, KnowledgeChunkSourceRef[]>;
  }): 'ownership' | 'image' | 'updated_at' | null {
    const {
      attachment,
      occurrence,
      chunkId,
      workspaceId,
      sourceRefsByChunkId,
    } = params;
    if (!attachment) return 'ownership';
    if (attachment.type !== AttachmentType.File) return 'ownership';
    if (attachment.deletedAt) return 'ownership';
    if (attachment.workspaceId !== workspaceId) return 'ownership';
    if (attachment.pageId !== occurrence.sourcePageId) return 'ownership';
    if (isImageAttachment(attachment)) return 'image';
    // §7.2.5: attachment_updated_at must still match the live attachment. This
    // is the check that catches a replaced file before its page recompiles.
    if (
      new Date(attachment.updatedAt).getTime() !==
      occurrence.attachmentUpdatedAt.getTime()
    ) {
      return 'updated_at';
    }
    // §7.2.5: source_version/source_content_hash must match the chunk's current
    // published source record for the same page.
    const matchingSource = (sourceRefsByChunkId.get(chunkId) ?? []).find(
      (source) => source.sourcePageId === occurrence.sourcePageId,
    );
    if (!matchingSource) return 'ownership';
    if (matchingSource.sourceVersion !== occurrence.sourceVersion) {
      return 'ownership';
    }
    if (matchingSource.contentHash !== occurrence.sourceContentHash) {
      return 'ownership';
    }
    return null;
  }

  private async buildAttachment(
    attachment: Attachment,
    workspaceId: string,
  ): Promise<KnowledgeQueryAttachment | null> {
    if (!attachment.pageId) return null;
    try {
      const token = await this.tokenService.generateAttachmentToken({
        attachmentId: attachment.id,
        pageId: attachment.pageId,
        workspaceId,
      });
      const appUrl = this.environmentService.getAppUrl();
      return {
        attachmentId: attachment.id,
        sourcePageId: attachment.pageId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        fileSize:
          attachment.fileSize === null ? null : Number(attachment.fileSize),
        url: `${appUrl}/api/files/public/${attachment.id}/${encodeURIComponent(
          attachment.fileName,
        )}?jwt=${token}`,
      };
    } catch {
      return null;
    }
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
