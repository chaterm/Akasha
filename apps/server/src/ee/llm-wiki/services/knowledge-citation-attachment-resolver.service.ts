import { Injectable } from '@nestjs/common';
import { Attachment } from '@akasha/db/types/entity.types';
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { TokenService } from '../../../core/auth/services/token.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import type { KnowledgeCitation } from './knowledge-context-pack.service';

export const MAX_KNOWLEDGE_QUERY_ATTACHMENTS = 15;

export type KnowledgeQueryAttachment = {
  attachmentId: string;
  sourcePageId: string;
  fileName: string;
  mimeType: string | null;
  fileSize: number | null;
  url: string;
};

/** Resolves downloadable attachments for pages that survived knowledge ACLs. */
@Injectable()
export class KnowledgeCitationAttachmentResolverService {
  constructor(
    private readonly attachmentRepo: AttachmentRepo,
    private readonly tokenService: TokenService,
    private readonly environmentService: EnvironmentService,
  ) {}

  async resolveAttachments(input: {
    workspaceId: string;
    citations: KnowledgeCitation[];
  }): Promise<KnowledgeQueryAttachment[]> {
    if (input.citations.length === 0) return [];

    const pageOrder = new Map<string, number>();
    for (const [index, citation] of input.citations.entries()) {
      if (!pageOrder.has(citation.sourcePageId)) {
        pageOrder.set(citation.sourcePageId, index);
      }
    }

    const attachments = await this.attachmentRepo.findByPageIds(
      [...pageOrder.keys()],
      input.workspaceId,
    );
    const ordered = attachments
      .filter(
        (attachment) =>
          attachment.type === AttachmentType.File &&
          attachment.pageId &&
          pageOrder.has(attachment.pageId),
      )
      .sort((a, b) => {
        const pageDelta = pageOrder.get(a.pageId!)! - pageOrder.get(b.pageId!)!;
        if (pageDelta !== 0) return pageDelta;
        const createdDelta =
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        return createdDelta !== 0 ? createdDelta : a.id.localeCompare(b.id);
      });

    const resolved = await Promise.all(
      ordered
        .slice(0, MAX_KNOWLEDGE_QUERY_ATTACHMENTS)
        .map((attachment) =>
          this.buildAttachment(attachment, input.workspaceId),
        ),
    );
    return resolved.filter(
      (attachment): attachment is KnowledgeQueryAttachment =>
        attachment !== null,
    );
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
