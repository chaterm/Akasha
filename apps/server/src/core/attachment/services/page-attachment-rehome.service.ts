import { Injectable, Logger } from '@nestjs/common';
import * as Y from 'yjs';
import { v7 as uuid7, validate as isValidUUID } from 'uuid';
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { Attachment, User } from '@akasha/db/types/entity.types';
import { KyselyTransaction } from '@akasha/db/types/kysely.types';
import { StorageService } from '../../../integrations/storage/storage.service';
import { PageAccessService } from '../../page/page-access/page-access.service';
import { AttachmentType } from '../attachment.constants';
import { isAttachmentNode } from '../../../common/helpers/prosemirror/attachment-node-types';
import { extractAttachmentIdFromUrl } from '../../../common/helpers/prosemirror/utils';

export type AttachmentRemap = Map<string, string>;

export interface AttachmentRehomeTarget {
  pageId: string;
  spaceId: string;
  workspaceId: string;
}

@Injectable()
export class PageAttachmentRehomeService {
  private readonly logger = new Logger(PageAttachmentRehomeService.name);

  constructor(
    private readonly attachmentRepo: AttachmentRepo,
    private readonly pageRepo: PageRepo,
    private readonly userRepo: UserRepo,
    private readonly storageService: StorageService,
    private readonly pageAccessService: PageAccessService,
  ) {}

  async copyForeignAttachments(
    attachmentIds: string[],
    target: AttachmentRehomeTarget,
    userId: string,
    trx?: KyselyTransaction,
  ): Promise<AttachmentRemap> {
    const remap: AttachmentRemap = new Map();
    if (attachmentIds.length === 0 || !userId) return remap;

    const attachments = await this.attachmentRepo.findByIds(attachmentIds, {
      trx,
    });
    const foreign = attachments.filter(
      (attachment) =>
        attachment.pageId &&
        attachment.pageId !== target.pageId &&
        attachment.workspaceId === target.workspaceId &&
        attachment.type === AttachmentType.File &&
        !attachment.deletedAt,
    );
    if (foreign.length === 0) return remap;

    const user = await this.userRepo.findById(userId, target.workspaceId, {
      trx,
    });
    if (!user) return remap;

    const viewable = new Map<string, boolean>();
    for (const attachment of foreign) {
      if (!viewable.has(attachment.pageId)) {
        viewable.set(
          attachment.pageId,
          await this.canViewPage(attachment.pageId, user, trx),
        );
      }
      if (!viewable.get(attachment.pageId)) continue;

      const newAttachmentId = await this.copyAttachment(
        attachment,
        target,
        trx,
      );
      if (newAttachmentId) remap.set(attachment.id, newAttachmentId);
    }

    return remap;
  }

  private async canViewPage(
    pageId: string,
    user: User,
    trx?: KyselyTransaction,
  ): Promise<boolean> {
    const page = await this.pageRepo.findById(pageId, { trx });
    if (!page) return false;
    try {
      await this.pageAccessService.validateCanView(page, user);
      return true;
    } catch {
      return false;
    }
  }

  private async copyAttachment(
    attachment: Attachment,
    target: AttachmentRehomeTarget,
    trx?: KyselyTransaction,
  ): Promise<string | null> {
    const newAttachmentId = uuid7();
    const newFilePath = attachment.filePath.replace(
      attachment.id,
      newAttachmentId,
    );
    if (newFilePath === attachment.filePath) return null;

    try {
      await this.storageService.copy(attachment.filePath, newFilePath);
      await this.attachmentRepo.insertAttachment(
        {
          id: newAttachmentId,
          type: attachment.type,
          filePath: newFilePath,
          fileName: attachment.fileName,
          fileSize: attachment.fileSize,
          mimeType: attachment.mimeType,
          fileExt: attachment.fileExt,
          creatorId: attachment.creatorId,
          workspaceId: attachment.workspaceId,
          pageId: target.pageId,
          spaceId: target.spaceId,
        },
        trx,
      );
      return newAttachmentId;
    } catch (err) {
      this.logger.error(
        `Failed to copy attachment ${attachment.id} to page ${target.pageId}`,
        err,
      );
      return null;
    }
  }
}

function remapAttributes(
  attrs: Record<string, unknown>,
  remap: AttachmentRemap,
): Record<string, string> | null {
  const oldId =
    typeof attrs.attachmentId === 'string' && isValidUUID(attrs.attachmentId)
      ? attrs.attachmentId
      : (extractAttachmentIdFromUrl(attrs.src) ??
        extractAttachmentIdFromUrl(attrs.url));
  const newId = oldId ? remap.get(oldId) : undefined;
  if (!oldId || !newId) return null;

  const updates: Record<string, string> = { attachmentId: newId };
  for (const key of ['src', 'url']) {
    const value = attrs[key];
    if (typeof value === 'string' && value.includes(oldId)) {
      updates[key] = value.replace(oldId, newId);
    }
  }
  return updates;
}

export function remapAttachmentsInJson<T>(content: T, remap: AttachmentRemap): T {
  if (remap.size === 0) return content;

  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const node = value as {
      type?: unknown;
      attrs?: Record<string, unknown>;
      content?: unknown;
    };
    let next: Record<string, unknown> = node as Record<string, unknown>;
    if (
      typeof node.type === 'string' &&
      isAttachmentNode(node.type) &&
      node.attrs
    ) {
      const updates = remapAttributes(node.attrs, remap);
      if (updates) next = { ...next, attrs: { ...node.attrs, ...updates } };
    }
    if (Array.isArray(node.content)) {
      next = { ...next, content: node.content.map(visit) };
    }
    return next;
  };

  return visit(content) as T;
}

export function remapAttachmentsInYdoc(
  doc: Y.Doc,
  remap: AttachmentRemap,
  fragmentName = 'default',
): number {
  if (remap.size === 0) return 0;
  let changed = 0;

  const visit = (element: Y.XmlElement | Y.XmlFragment) => {
    for (const child of element.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (isAttachmentNode(child.nodeName)) {
        const updates = remapAttributes(child.getAttributes(), remap);
        if (updates) {
          for (const [key, value] of Object.entries(updates)) {
            child.setAttribute(key, value);
          }
          changed += 1;
        }
      }
      visit(child);
    }
  };

  doc.transact(() => visit(doc.getXmlFragment(fragmentName)));
  return changed;
}
