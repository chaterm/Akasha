import { Injectable, Logger } from '@nestjs/common';
import { convert } from '@opendataloader/pdf';
import { markdownToHtml } from '@docmost/editor-ext';
import { v7 as uuid7 } from 'uuid';
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import { StorageService } from '../../integrations/storage/storage.service';
import { AttachmentType } from '../../core/attachment/attachment.constants';
import { getAttachmentFolderPath } from '../../core/attachment/attachment.utils';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as os from 'os';
import pLimit from 'p-limit';
import { normalizePdfTableOfContents } from './pdf-markdown.utils';

@Injectable()
export class PdfImportService {
  private readonly logger = new Logger(PdfImportService.name);
  private readonly concurrentImageUploads = 3;

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
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'akasha-pdf-'));
    const inputPath = path.join(tempDir, 'document.pdf');
    const outputDir = path.join(tempDir, 'output');

    try {
      await fs.mkdir(outputDir);
      await fs.writeFile(inputPath, fileBuffer);
      await convert(inputPath, {
        outputDir,
        format: 'markdown',
        imageOutput: 'external',
        readingOrder: 'xycut',
        quiet: true,
      });

      const markdownPath = path.join(outputDir, 'document.md');
      let markdown = await fs.readFile(markdownPath, 'utf8');
      markdown = normalizePdfTableOfContents(markdown);
      markdown = this.normalizeMarkdownTables(markdown);
      markdown = await this.uploadReferencedImages(
        markdown,
        outputDir,
        workspaceId,
        spaceId,
        pageId,
        userId,
      );

      return markdownToHtml(markdown);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private normalizeMarkdownTables(markdown: string): string {
    const lines = markdown.split('\n');
    const tableSeparator = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?$/;
    const tableArtifact = /^(?:\|\s*|\|\s*:?-+:?\s*\|\s*)$/;

    for (let i = 0; i < lines.length; i++) {
      // OpenDataLoader can emit an empty leading cell when a PDF table has
      // merged cells. Remove it when the following separator has fewer cells.
      if (
        lines[i].startsWith('||') &&
        tableSeparator.test(lines[i + 1] ?? '')
      ) {
        lines[i] = lines[i].slice(1);
      }

      // A trailing one-column separator is a layout marker, not a data row.
      if (tableArtifact.test(lines[i])) {
        lines[i] = '';
      }
    }

    return lines.join('\n');
  }

  private async uploadReferencedImages(
    markdown: string,
    outputDir: string,
    workspaceId: string,
    spaceId: string,
    pageId: string,
    userId: string,
  ): Promise<string> {
    const imageReferencePattern =
      /(!\[(?:\\.|[^\]\\])*\]\()(<[^<>\r\n]+>|[^\s)]+)((?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'))?[ \t]*\))/g;
    const imageSources = [...markdown.matchAll(imageReferencePattern)].map(
      (match) => this.getImageSource(match[2]),
    );
    const uniqueSources = [...new Set(imageSources)];
    const limit = pLimit(this.concurrentImageUploads);

    const uploadedImages = await Promise.all(
      uniqueSources.map((source, i) =>
        limit(async () => {
          try {
            const imagePath = path.resolve(
              outputDir,
              decodeURIComponent(source),
            );

            if (
              !imagePath.startsWith(`${path.resolve(outputDir)}${path.sep}`)
            ) {
              this.logger.warn(
                `Skipping PDF image outside output directory: ${source}`,
              );
              return null;
            }

            const imageData = await fs.readFile(imagePath);
            const ext = path.extname(imagePath).toLowerCase() || '.png';
            const contentType =
              ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
            const fileName = `${uuid7()}${ext}`;
            const attachmentId = uuid7();
            const filePath = `${getAttachmentFolderPath(AttachmentType.File, workspaceId)}/${attachmentId}/${fileName}`;

            await this.storageService.upload(filePath, imageData);
            await this.attachmentRepo.insertAttachment({
              id: attachmentId,
              type: AttachmentType.File,
              filePath,
              fileName,
              fileSize: imageData.length,
              mimeType: contentType,
              fileExt: path.extname(fileName),
              creatorId: userId,
              workspaceId,
              pageId,
              spaceId,
            });

            return {
              source,
              replacement: `/api/files/${attachmentId}/${fileName}`,
            };
          } catch (err) {
            this.logger.warn(`Failed to upload PDF image ${i}`, err);
            return null;
          }
        }),
      ),
    );

    const replacements = new Map(
      uploadedImages
        .filter((image): image is NonNullable<typeof image> => image !== null)
        .map(({ source, replacement }) => [source, replacement]),
    );

    return markdown.replace(
      imageReferencePattern,
      (match, prefix: string, destination: string, suffix: string) => {
        const replacement = replacements.get(this.getImageSource(destination));
        if (!replacement) return match;
        const url = destination.startsWith('<')
          ? `<${replacement}>`
          : replacement;
        return `${prefix}${url}${suffix}`;
      },
    );
  }

  private getImageSource(destination: string): string {
    // OpenDataLoader uses CommonMark's <...> destination form, including for
    // paths with spaces or parentheses. The brackets are not part of the file.
    return destination.startsWith('<') ? destination.slice(1, -1) : destination;
  }
}
