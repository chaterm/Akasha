import { Injectable, Logger } from '@nestjs/common';
import * as mammoth from 'mammoth';
import { v7 as uuid7 } from 'uuid';
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import { StorageService } from '../../integrations/storage/storage.service';
import { AttachmentType } from '../../core/attachment/attachment.constants';
import { getAttachmentFolderPath } from '../../core/attachment/attachment.utils';
import * as path from 'path';

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
};

@Injectable()
export class DocxImportService {
  private readonly logger = new Logger(DocxImportService.name);

  constructor(
    private readonly attachmentRepo: AttachmentRepo,
    private readonly storageService: StorageService,
  ) {}

  async convertDocxToHtml(
    fileBuffer: Buffer,
    workspaceId: string,
    spaceId: string,
    pageId: string,
    userId: string,
  ): Promise<string> {
    const result = await mammoth.convertToHtml(
      { buffer: fileBuffer },
      {
        convertImage: mammoth.images.imgElement(async (image) => {
          try {
            const imageBuffer: Buffer = await image.read();
            const contentType = image.contentType || 'image/png';
            const ext = MIME_TO_EXT[contentType] ?? contentType.split('/')[1] ?? 'png';
            const fileName = `${uuid7()}.${ext}`;
            const attachmentId = uuid7();
            const filePath = `${getAttachmentFolderPath(AttachmentType.File, workspaceId)}/${attachmentId}/${fileName}`;

            await this.storageService.upload(filePath, imageBuffer);

            await this.attachmentRepo.insertAttachment({
              id: attachmentId,
              type: AttachmentType.File,
              filePath,
              fileName,
              fileSize: imageBuffer.length,
              mimeType: contentType,
              fileExt: path.extname(fileName),
              creatorId: userId,
              workspaceId,
              pageId,
              spaceId,
            });

            return { src: `/api/files/${attachmentId}/${fileName}` };
          } catch (err) {
            this.logger.warn('Failed to upload image from docx', err);
            return { src: '' };
          }
        }),
      },
    );

    if (result.messages?.length) {
      result.messages
        .filter((m) => m.type === 'error')
        .forEach((m) => this.logger.warn('mammoth warning:', m.message));
    }

    return result.value;
  }
}
