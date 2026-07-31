import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { BacklinkRepo } from '@akasha/db/repos/backlink/backlink.repo';
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import { Attachment } from '@akasha/db/types/entity.types';
import {
  KnowledgeSourceImage,
  KnowledgeSourceImageMimeType,
  KnowledgeSourceSnapshot,
} from '../types/source-snapshot.types';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { InjectKysely } from 'nestjs-kysely';
import {
  KyselyDB,
  KyselyTransaction,
} from '../../../database/types/kysely.types';

const KNOWLEDGE_EXPORT_PAGE_SIZE = 200;

@Injectable()
export class KnowledgeSourceExporterService {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly backlinkRepo: BacklinkRepo,
    private readonly attachmentRepo: AttachmentRepo,
    @InjectKysely() private readonly db: KyselyDB = undefined as never,
  ) {}

  async exportSpaceSources(input: {
    workspaceId: string;
    spaceId: string;
    abortSignal?: AbortSignal;
  }): Promise<KnowledgeSourceSnapshot[]> {
    input.abortSignal?.throwIfAborted();
    const scope = { workspaceId: input.workspaceId, spaceId: input.spaceId };
    return this.inReadSnapshot(async (trx) => {
      const snapshots: KnowledgeSourceSnapshot[] = [];
      let after: { updatedAt: Date; id: string } | undefined;
      do {
        const query = {
          ...scope,
          limit: KNOWLEDGE_EXPORT_PAGE_SIZE,
          ...(after ? { after } : {}),
        };
        const pages = trx
          ? await this.pageRepo.findPagesForKnowledgeExport(query, trx)
          : await this.pageRepo.findPagesForKnowledgeExport(query);
        snapshots.push(
          ...(await this.toSnapshots(input.workspaceId, pages, trx)),
        );
        input.abortSignal?.throwIfAborted();
        const last = pages[pages.length - 1];
        after =
          pages.length === KNOWLEDGE_EXPORT_PAGE_SIZE && last
            ? { updatedAt: last.updatedAt, id: last.id }
            : undefined;
      } while (after);
      return snapshots;
    });
  }

  async exportPageSources(input: {
    workspaceId: string;
    spaceId: string;
    sourcePageIds: string[];
    abortSignal?: AbortSignal;
  }): Promise<KnowledgeSourceSnapshot[]> {
    input.abortSignal?.throwIfAborted();
    return this.inReadSnapshot(async (trx) => {
      const snapshots: KnowledgeSourceSnapshot[] = [];
      for (
        let offset = 0;
        offset < input.sourcePageIds.length;
        offset += KNOWLEDGE_EXPORT_PAGE_SIZE
      ) {
        const query = {
          workspaceId: input.workspaceId,
          spaceId: input.spaceId,
          pageIds: input.sourcePageIds.slice(
            offset,
            offset + KNOWLEDGE_EXPORT_PAGE_SIZE,
          ),
        };
        const pages = trx
          ? await this.pageRepo.findPagesByIdsForKnowledgeExport(query, trx)
          : await this.pageRepo.findPagesByIdsForKnowledgeExport(query);
        snapshots.push(
          ...(await this.toSnapshots(input.workspaceId, pages, trx)),
        );
        input.abortSignal?.throwIfAborted();
      }
      return snapshots;
    });
  }

  private async toSnapshots(
    workspaceId: string,
    pages: Array<{
      id: string;
      workspaceId: string;
      spaceId: string;
      title: string;
      textContent: string | null;
      content: unknown;
      updatedAt: Date;
    }>,
    trx?: KyselyTransaction,
  ): Promise<KnowledgeSourceSnapshot[]> {
    const imageRefsByPageId = new Map(
      pages.map((page) => [page.id, findPageImageReferences(page.content)]),
    );
    const attachmentIds = unique(
      [...imageRefsByPageId.values()].flatMap((images) =>
        images.map((image) => image.attachmentId),
      ),
    );
    const attachments = trx
      ? await this.attachmentRepo.findByIds(attachmentIds, { trx })
      : await this.attachmentRepo.findByIds(attachmentIds);
    const attachmentById = new Map(
      attachments.map((attachment) => [attachment.id, attachment]),
    );
    const referenceQuery = {
      workspaceId,
      sourcePageIds: pages.map((page) => page.id),
    };
    const references = trx
      ? await this.backlinkRepo.findOutgoingPageReferences(referenceQuery, trx)
      : await this.backlinkRepo.findOutgoingPageReferences(referenceQuery);
    const referencesBySourcePageId = groupBy(
      references,
      (reference) => reference.sourcePageId,
    );

    return pages.map((page) => {
      const text = page.textContent ?? '';
      const title = page.title ?? '';
      const images = (imageRefsByPageId.get(page.id) ?? []).flatMap(
        (reference): KnowledgeSourceImage[] => {
          const attachment = attachmentById.get(reference.attachmentId);
          const mimeType = attachment
            ? supportedPageImageMimeType(attachment)
            : undefined;
          if (
            !attachment ||
            !mimeType ||
            attachment.workspaceId !== page.workspaceId ||
            attachment.spaceId !== page.spaceId ||
            attachment.pageId !== page.id ||
            attachment.type !== AttachmentType.File ||
            attachment.deletedAt
          ) {
            return [];
          }
          return [
            {
              attachmentId: attachment.id,
              fileName: attachment.fileName,
              mimeType,
              fileSize:
                attachment.fileSize === null
                  ? null
                  : Number(attachment.fileSize),
              attachmentVersion: attachment.updatedAt.toISOString(),
              ...(reference.altText ? { altText: reference.altText } : {}),
            },
          ];
        },
      );
      return {
        workspaceId: page.workspaceId,
        spaceId: page.spaceId,
        sourcePageId: page.id,
        sourceVersion: page.updatedAt.toISOString(),
        contentHash: `sha256:${hashSource(title, text, page.content, images)}`,
        title,
        text,
        content: page.content ?? undefined,
        ...(images.length > 0 ? { images } : {}),
        references: (referencesBySourcePageId.get(page.id) ?? []).map(
          (reference) => ({
            sourcePageId: page.id,
            targetPageId: reference.targetPageId,
            targetSpaceId: reference.targetSpaceId,
            kind:
              reference.targetSpaceId === page.spaceId
                ? ('same_space_reference' as const)
                : ('cross_space_reference' as const),
            mode: 'opaque' as const,
          }),
        ),
      };
    });
  }

  private async inReadSnapshot<T>(
    callback: (trx?: KyselyTransaction) => Promise<T>,
  ): Promise<T> {
    if (!this.db) return callback(undefined);
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute((trx) => callback(trx));
  }
}

function groupBy<T>(
  values: T[],
  keyOf: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  return grouped;
}

function hashSource(
  title: string,
  text: string,
  content: unknown,
  images: KnowledgeSourceImage[],
): string {
  return createHash('sha256')
    .update(title)
    .update('\n')
    .update(text)
    .update('\n')
    .update(content ? JSON.stringify(content) : '')
    .update('\n')
    .update(
      JSON.stringify(
        images.map((image) => ({
          attachmentId: image.attachmentId,
          attachmentVersion: image.attachmentVersion,
          fileSize: image.fileSize,
        })),
      ),
    )
    .digest('hex');
}

type PageImageReference = {
  attachmentId: string;
  altText?: string;
};

function findPageImageReferences(content: unknown): PageImageReference[] {
  const images: PageImageReference[] = [];
  const seen = new Set<string>();

  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const node = value as {
      type?: unknown;
      attrs?: unknown;
      content?: unknown;
    };
    if (node.type === 'image' && node.attrs && typeof node.attrs === 'object') {
      const attrs = node.attrs as {
        attachmentId?: unknown;
        alt?: unknown;
      };
      const attachmentId =
        typeof attrs.attachmentId === 'string' ? attrs.attachmentId.trim() : '';
      if (attachmentId && !seen.has(attachmentId)) {
        seen.add(attachmentId);
        const altText =
          typeof attrs.alt === 'string' ? attrs.alt.trim() : undefined;
        images.push({
          attachmentId,
          ...(altText ? { altText } : {}),
        });
      }
    }
    if (Array.isArray(node.content)) {
      node.content.forEach(visit);
    }
  };

  visit(content);
  return images;
}

function supportedPageImageMimeType(
  attachment: Attachment,
): KnowledgeSourceImage['mimeType'] | undefined {
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  if (mimeType) {
    const normalizedMimeType = SAFE_RASTER_MIME_ALIASES.get(mimeType);
    if (normalizedMimeType) return normalizedMimeType;

    // Never reinterpret an explicitly declared, unsupported image format from
    // its extension. In particular, this prevents SVG from entering the
    // raster pipeline merely because it has a misleading filename.
    if (mimeType.startsWith('image/')) return undefined;
    if (mimeType !== 'application/octet-stream') return undefined;
  }

  const extension = attachment.fileExt.toLowerCase();
  return SAFE_RASTER_EXTENSION_TYPES.get(extension);
}

const SAFE_RASTER_MIME_ALIASES = new Map<string, KnowledgeSourceImageMimeType>([
  ['image/jpeg', 'image/jpeg'],
  ['image/jpg', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
  ['image/png', 'image/png'],
  ['image/x-png', 'image/png'],
  ['image/apng', 'image/apng'],
  ['image/gif', 'image/gif'],
  ['image/webp', 'image/webp'],
  ['image/avif', 'image/avif'],
  ['image/tiff', 'image/tiff'],
  ['image/x-tiff', 'image/tiff'],
  ['image/bmp', 'image/bmp'],
  ['image/x-bmp', 'image/bmp'],
  ['image/x-ms-bmp', 'image/bmp'],
]);

const SAFE_RASTER_EXTENSION_TYPES = new Map<
  string,
  KnowledgeSourceImageMimeType
>([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.jpe', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.apng', 'image/apng'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.bmp', 'image/bmp'],
  ['.dib', 'image/bmp'],
]);

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
