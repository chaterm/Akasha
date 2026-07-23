import { Injectable, Logger } from '@nestjs/common';
import { processPdfWithImages } from '@docmost/pdf-inspector';
import { v7 as uuid7 } from 'uuid';
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import { StorageService } from '../../integrations/storage/storage.service';
import { AttachmentType } from '../../core/attachment/attachment.constants';
import { getAttachmentFolderPath } from '../../core/attachment/attachment.utils';
import * as path from 'path';
import { markdownToHtml } from '@docmost/editor-ext';

@Injectable()
export class PdfImportService {
  private readonly logger = new Logger(PdfImportService.name);

  constructor(
    private readonly attachmentRepo: AttachmentRepo,
    private readonly storageService: StorageService,
  ) {}

  async convertPdfToHtml(
    fileBuffer: Buffer,
    workspaceId: string,
    spaceId: string,
    pageId: string,
    userId: string,
  ): Promise<string> {
    const result = processPdfWithImages(fileBuffer);
    let markdown = result.markdown ?? '';

    if (result.images?.length) {
      const uploadedSrcs = await Promise.all(
        result.images.map(async (image, i) => {
          try {
            const ext = image.format === 'Jpeg' ? 'jpg' : 'png';
            const contentType = image.format === 'Jpeg' ? 'image/jpeg' : 'image/png';
            const fileName = `${uuid7()}.${ext}`;
            const attachmentId = uuid7();
            const filePath = `${getAttachmentFolderPath(AttachmentType.File, workspaceId)}/${attachmentId}/${fileName}`;

            await this.storageService.upload(filePath, image.data);

            await this.attachmentRepo.insertAttachment({
              id: attachmentId,
              type: AttachmentType.File,
              filePath,
              fileName,
              fileSize: image.data.length,
              mimeType: contentType,
              fileExt: path.extname(fileName),
              creatorId: userId,
              workspaceId,
              pageId,
              spaceId,
            });

            return `/api/files/${attachmentId}/${fileName}`;
          } catch (err) {
            this.logger.warn(`Failed to upload pdf image ${i}`, err);
            return null;
          }
        }),
      );

      for (let i = 0; i < uploadedSrcs.length; i++) {
        const placeholder = `![image](pdf-image://${i})`;
        const replacement = uploadedSrcs[i] ? `![image](${uploadedSrcs[i]})` : '';
        markdown = markdown.split(placeholder).join(replacement);
      }
    }

    return markdownToHtml(markdown);
  }
}
