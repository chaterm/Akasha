import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { cleanUrlString } from '../utils/file.utils';
import { StorageService } from '../../storage/storage.service';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'fs';
import { Readable } from 'stream';
import { getMimeType, sanitizeFileName } from '../../../common/helpers';
import { v7 } from 'uuid';
import { FileTask } from '@akasha/db/types/entity.types';
import { getAttachmentFolderPath } from '../../../core/attachment/attachment.utils';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { unwrapFromParagraph } from '../utils/import-formatter';
import { resolveRelativeAttachmentPath } from '../utils/import.utils';
import { imageDimensionsFromData } from 'image-dimensions';
import { load } from 'cheerio';
import pLimit from 'p-limit';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueJob, QueueName } from '../../queue/constants';

export interface AttachmentInfo {
  href: string;
  fileName: string;
  mimeType: string;
  includeInBody?: boolean;
}

interface DrawioPair {
  drawioFile?: AttachmentInfo;
  pngFile?: AttachmentInfo;
  baseName: string;
}

@Injectable()
export class ImportAttachmentService {
  private readonly logger = new Logger(ImportAttachmentService.name);
  private readonly CONCURRENT_UPLOADS = 3;
  private readonly MAX_RETRIES = 2;
  private readonly RETRY_DELAY = 2000;

  constructor(
    private readonly storageService: StorageService,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.ATTACHMENT_QUEUE) private attachmentQueue: Queue,
  ) {}

  async processAttachments(opts: {
    html: string;
    pageRelativePath: string;
    extractDir: string;
    pageId: string;
    fileTask: FileTask;
    attachmentCandidates: Map<string, string>;
    pageAttachments?: AttachmentInfo[];
    isConfluenceImport?: boolean;
  }): Promise<string> {
    const {
      html,
      pageRelativePath,
      extractDir,
      pageId,
      fileTask,
      attachmentCandidates,
      pageAttachments = [],
      isConfluenceImport,
    } = opts;

    const attachmentTasks: (() => Promise<void>)[] = [];
    const failedAttachmentIds = new Set<string>();
    const limit = pLimit(this.CONCURRENT_UPLOADS);
    const uploadStats = {
      total: 0,
      completed: 0,
      failed: 0,
      failedFiles: [] as string[],
    };

    const processed = new Map<
      string,
      {
        attachmentId: string;
        storageFilePath: string;
        apiFilePath: string;
        fileNameWithExt: string;
        abs: string;
      }
    >();

    const { drawioPairs, skipFiles } = this.analyzeAttachments(
      pageAttachments,
      isConfluenceImport,
    );

    const drawioSvgMap = new Map<
      string,
      {
        attachmentId: string;
        apiFilePath: string;
        fileName: string;
      }
    >();

    for (const [drawioHref, pair] of drawioPairs) {
      if (!pair.drawioFile) continue;

      const drawioAbsPath = attachmentCandidates.get(drawioHref);
      if (!drawioAbsPath) continue;

      const pngAbsPath = pair.pngFile
        ? attachmentCandidates.get(pair.pngFile.href)
        : undefined;

      try {
        const svgBuffer = await this.createDrawioSvg(drawioAbsPath, pngAbsPath);

        const attachmentId = v7();
        const fileName = 'diagram.drawio.svg';
        const storageFilePath = `${getAttachmentFolderPath(
          AttachmentType.File,
          fileTask.workspaceId,
        )}/${attachmentId}/${fileName}`;
        const apiFilePath = `/api/files/${attachmentId}/${fileName}`;

        attachmentTasks.push(async () => {
          try {
            const stream = Readable.from(svgBuffer);

            await this.storageService.uploadStream(storageFilePath, stream, {
              recreateClient: true,
            });

            await this.db
              .insertInto('attachments')
              .values({
                id: attachmentId,
                filePath: storageFilePath,
                fileName: fileName,
                fileSize: svgBuffer.length,
                mimeType: 'image/svg+xml',
                type: 'file',
                fileExt: '.svg',
                creatorId: fileTask.creatorId,
                workspaceId: fileTask.workspaceId,
                pageId,
                spaceId: fileTask.spaceId,
              })
              .execute();

            uploadStats.completed++;
          } catch (error) {
            uploadStats.failed++;
            uploadStats.failedFiles.push(fileName);
            this.logger.error(
              { fileName, err: error },
              'Failed to upload Draw.io SVG',
            );
          }
        });

        drawioSvgMap.set(drawioHref, { attachmentId, apiFilePath, fileName });
        if (pair.pngFile) {
          drawioSvgMap.set(pair.pngFile.href, {
            attachmentId,
            apiFilePath,
            fileName,
          });
        }
      } catch (error) {
        this.logger.error(
          { baseName: pair.baseName, err: error },
          'Failed to process Draw.io pair',
        );
      }
    }

    const pageDir = path.dirname(pageRelativePath);
    const attachmentNameByRelPath = new Map<string, string>();
    for (const attachment of pageAttachments) {
      const relPath = resolveRelativeAttachmentPath(
        attachment.href,
        pageDir,
        attachmentCandidates,
      );
      if (relPath && attachment.fileName) {
        attachmentNameByRelPath.set(relPath, attachment.fileName);

        const dir = path.posix.dirname(relPath);
        const aliasKey = `${dir}/${attachment.fileName}`;
        if (!attachmentCandidates.has(aliasKey)) {
          attachmentCandidates.set(
            aliasKey,
            attachmentCandidates.get(relPath)!,
          );
          attachmentNameByRelPath.set(aliasKey, attachment.fileName);
        }
      }
    }

    const uploadOnce = (relPath: string) => {
      const abs = attachmentCandidates.get(relPath)!;
      const attachmentId = v7();

      const realName = attachmentNameByRelPath.get(relPath);
      const baseName = realName || path.basename(abs);
      const ext = path.extname(baseName);

      const fileNameWithExt =
        sanitizeFileName(path.basename(baseName, ext)) + ext.toLowerCase();

      const storageFilePath = `${getAttachmentFolderPath(
        AttachmentType.File,
        fileTask.workspaceId,
      )}/${attachmentId}/${fileNameWithExt}`;

      const apiFilePath = `/api/files/${attachmentId}/${fileNameWithExt}`;

      attachmentTasks.push(async () => {
        const uploaded = await this.uploadWithRetry({
          abs,
          storageFilePath,
          attachmentId,
          fileNameWithExt,
          ext,
          pageId,
          fileTask,
          uploadStats,
        });
        if (!uploaded) failedAttachmentIds.add(attachmentId);
      });

      return {
        attachmentId,
        storageFilePath,
        apiFilePath,
        fileNameWithExt,
        abs,
      };
    };

    const processFile = (relPath: string) => {
      const absPath = attachmentCandidates.get(relPath)!;
      const cached = processed.get(absPath);
      if (cached) return cached;

      const fresh = uploadOnce(relPath);
      processed.set(absPath, fresh);
      return fresh;
    };

    const $ = load(html);

    for (const imgEl of $('img').toArray()) {
      const $img = $(imgEl);
      const src = cleanUrlString($img.attr('src') ?? '')!;
      if (!src || src.startsWith('http')) continue;

      const relPath = resolveRelativeAttachmentPath(
        src,
        pageDir,
        attachmentCandidates,
      );
      if (!relPath) continue;

      const drawioSvg = drawioSvgMap.get(relPath);
      if (drawioSvg) {
        const $drawio = $('<div>')
          .attr('data-type', 'drawio')
          .attr('data-src', drawioSvg.apiFilePath)
          .attr('data-title', 'diagram')
          .attr('data-width', '100%')
          .attr('data-align', 'center')
          .attr('data-attachment-id', drawioSvg.attachmentId);

        $img.replaceWith($drawio);
        unwrapFromParagraph($, $drawio);
        continue;
      }

      const { attachmentId, apiFilePath, abs } = processFile(relPath);

      let width = $img.attr('width');
      const height = $img.attr('height');
      const align = $img.attr('data-align') ?? 'center';

      if (!width) {
        try {
          const buf = await fs.readFile(abs);
          const natural = imageDimensionsFromData(new Uint8Array(buf));
          if (natural) {
            width = height
              ? String(
                  Math.round((natural.width / natural.height) * Number(height)),
                )
              : String(natural.width);
          }
        } catch {
          /* empty */
        }

        if (!width) {
          width = '600';
        }
      }

      $img
        .attr('src', apiFilePath)
        .attr('data-attachment-id', attachmentId)
        .attr('width', width)
        .attr('height', height)
        .attr('data-align', align);

      unwrapFromParagraph($, $img);
    }

    for (const vidEl of $('video').toArray()) {
      const $vid = $(vidEl);
      const src = cleanUrlString($vid.attr('src') ?? '')!;
      if (!src || src.startsWith('http')) continue;

      const relPath = resolveRelativeAttachmentPath(
        src,
        pageDir,
        attachmentCandidates,
      );
      if (!relPath) continue;

      const { attachmentId, apiFilePath } = processFile(relPath);

      const width = $vid.attr('width') ?? '100%';
      const align = $vid.attr('data-align') ?? 'center';

      $vid
        .attr('src', apiFilePath)
        .attr('data-attachment-id', attachmentId)
        .attr('width', width)
        .attr('data-align', align);

      unwrapFromParagraph($, $vid);
    }

    for (const audEl of $('audio').toArray()) {
      const $aud = $(audEl);
      const src = cleanUrlString($aud.attr('src') ?? '')!;
      if (!src || src.startsWith('http')) continue;

      const relPath = resolveRelativeAttachmentPath(
        src,
        pageDir,
        attachmentCandidates,
      );
      if (!relPath) continue;

      const { attachmentId, apiFilePath } = processFile(relPath);

      $aud.attr('src', apiFilePath).attr('data-attachment-id', attachmentId);

      unwrapFromParagraph($, $aud);
    }

    for (const el of $('div[data-type="attachment"]').toArray()) {
      const $oldDiv = $(el);
      const rawUrl = cleanUrlString($oldDiv.attr('data-attachment-url') ?? '')!;
      if (!rawUrl || rawUrl.startsWith('http')) continue;
      const inFileList = $oldDiv.parent().is('div[data-type="fileList"]');

      const relPath = resolveRelativeAttachmentPath(
        rawUrl,
        pageDir,
        attachmentCandidates,
      );
      if (!relPath) {
        if (inFileList && isConfluenceImport)
          $oldDiv.removeAttr('data-attachment-url');
        continue;
      }

      const { attachmentId, apiFilePath, abs, fileNameWithExt } =
        processFile(relPath);
      if (inFileList) {
        $oldDiv
          .attr('data-attachment-url', apiFilePath)
          .attr('data-attachment-id', attachmentId)
          .attr(
            'data-attachment-mime',
            $oldDiv.attr('data-attachment-mime') ||
              getMimeType(fileNameWithExt),
          );
        continue;
      }
      const fileName = path.basename(abs);
      const mime = getMimeType(abs);

      const $newDiv = $('<div>')
        .attr('data-type', 'attachment')
        .attr('data-attachment-url', apiFilePath)
        .attr('data-attachment-name', fileName)
        .attr('data-attachment-mime', mime)
        .attr('data-attachment-id', attachmentId);

      $oldDiv.replaceWith($newDiv);
      unwrapFromParagraph($, $newDiv);
    }

    for (const aEl of $('a').toArray()) {
      const $a = $(aEl);
      const href = cleanUrlString($a.attr('href') ?? '')!;
      if (!href || href.startsWith('http')) continue;

      const relPath = resolveRelativeAttachmentPath(
        href,
        pageDir,
        attachmentCandidates,
      );
      if (!relPath) continue;

      const drawioSvg = drawioSvgMap.get(relPath);
      if (drawioSvg) {
        const $drawio = $('<div>')
          .attr('data-type', 'drawio')
          .attr('data-src', drawioSvg.apiFilePath)
          .attr('data-title', 'diagram')
          .attr('data-width', '100%')
          .attr('data-align', 'center')
          .attr('data-attachment-id', drawioSvg.attachmentId);

        $a.replaceWith($drawio);
        unwrapFromParagraph($, $drawio);
        continue;
      }

      if (skipFiles.has(relPath)) {
        $a.remove();
        continue;
      }

      const { attachmentId, apiFilePath, abs } = processFile(relPath);
      const ext = path.extname(relPath).toLowerCase();

      const audioExtensions = new Set([
        '.mp3',
        '.wav',
        '.ogg',
        '.m4a',
        '.webm',
        '.flac',
        '.aac',
      ]);

      if (ext === '.pdf') {
        const $pdf = $('<div>')
          .attr('data-type', 'pdf')
          .attr('src', apiFilePath)
          .attr('data-attachment-id', attachmentId)
          .attr('width', '800')
          .attr('height', '600');
        $a.replaceWith($pdf);
        unwrapFromParagraph($, $pdf);
      } else if (ext === '.mp4') {
        const $video = $('<video>')
          .attr('src', apiFilePath)
          .attr('data-attachment-id', attachmentId)
          .attr('width', '100%')
          .attr('data-align', 'center');
        $a.replaceWith($video);
        unwrapFromParagraph($, $video);
      } else if (audioExtensions.has(ext)) {
        const $audio = $('<audio>')
          .attr('src', apiFilePath)
          .attr('data-attachment-id', attachmentId);
        $a.replaceWith($audio);
        unwrapFromParagraph($, $audio);
      } else {
        const confAliasName = $a.attr('data-linked-resource-default-alias');
        let attachmentName = path.basename(abs);
        if (confAliasName) attachmentName = confAliasName;

        const $div = $('<div>')
          .attr('data-type', 'attachment')
          .attr('data-attachment-url', apiFilePath)
          .attr('data-attachment-name', attachmentName)
          .attr('data-attachment-mime', getMimeType(abs))
          .attr('data-attachment-id', attachmentId);

        $a.replaceWith($div);
        unwrapFromParagraph($, $div);
      }
    }

    for (const type of ['excalidraw', 'drawio'] as const) {
      for (const el of $(`div[data-type="${type}"]`).toArray()) {
        const $oldDiv = $(el);
        const rawSrc = cleanUrlString($oldDiv.attr('data-src') ?? '')!;
        if (!rawSrc || rawSrc.startsWith('http')) continue;

        const relPath = resolveRelativeAttachmentPath(
          rawSrc,
          pageDir,
          attachmentCandidates,
        );
        if (!relPath) continue;

        const { attachmentId, apiFilePath, abs } = processFile(relPath);
        const fileName = path.basename(abs);

        const width = $oldDiv.attr('data-width') || '600';
        const align = $oldDiv.attr('data-align') || 'center';

        const $newDiv = $('<div>')
          .attr('data-type', type)
          .attr('data-src', apiFilePath)
          .attr('data-title', fileName)
          .attr('data-width', width)
          .attr('data-align', align)
          .attr('data-attachment-id', attachmentId);

        $oldDiv.replaceWith($newDiv);
        unwrapFromParagraph($, $newDiv);
      }
    }

    const usedAttachmentIds = new Set<string>();
    $.root()
      .find('[data-attachment-id]')
      .each((_, el) => {
        const attachmentId = $(el).attr('data-attachment-id');
        if (attachmentId) {
          usedAttachmentIds.add(attachmentId);
        }
      });

    for (const [drawioHref, pair] of drawioPairs) {
      const drawioSvg = drawioSvgMap.get(drawioHref);
      if (!drawioSvg) continue;

      if (usedAttachmentIds.has(drawioSvg.attachmentId)) {
        continue;
      }

      const $drawio = $('<div>')
        .attr('data-type', 'drawio')
        .attr('data-src', drawioSvg.apiFilePath)
        .attr('data-title', 'diagram')
        .attr('data-width', '600')
        .attr('data-align', 'center')
        .attr('data-attachment-id', drawioSvg.attachmentId);

      $.root().append($drawio);
    }

    for (const attachment of pageAttachments) {
      const { href, fileName, mimeType } = attachment;

      if (skipFiles.has(href)) {
        continue;
      }

      if (drawioSvgMap.has(href)) {
        continue;
      }

      const resolvedHref = resolveRelativeAttachmentPath(
        href,
        pageDir,
        attachmentCandidates,
      );
      if (!resolvedHref) continue;

      const absPath = attachmentCandidates.get(resolvedHref);
      if (processed.has(absPath)) continue;

      const { attachmentId, apiFilePath, abs } = processFile(resolvedHref);
      if (attachment.includeInBody === false) continue;
      const mime = mimeType || getMimeType(abs);

      const $attachmentDiv = $('<div>')
        .attr('data-type', 'attachment')
        .attr('data-attachment-url', apiFilePath)
        .attr('data-attachment-name', fileName)
        .attr('data-attachment-mime', mime)
        .attr('data-attachment-id', attachmentId);

      $.root().append($attachmentDiv);
    }

    uploadStats.total = attachmentTasks.length;

    if (uploadStats.total > 0) {
      try {
        await Promise.all(attachmentTasks.map((task) => limit(task)));
      } catch (err) {
        this.logger.error({ err }, 'Import attachment upload error');
      }

      if (uploadStats.failed > 0) {
        this.logger.warn(
          {
            failed: uploadStats.failed,
            total: uploadStats.total,
            failedFiles: uploadStats.failedFiles,
          },
          'Some attachment uploads failed',
        );
      }
    }

    if (failedAttachmentIds.size) {
      $('div[data-type="fileList"] > div[data-type="attachment"]').each(
        (_, el) => {
          const $file = $(el);
          if (failedAttachmentIds.has($file.attr('data-attachment-id') ?? '')) {
            $file
              .removeAttr('data-attachment-id')
              .removeAttr('data-attachment-url');
          }
        },
      );
    }

    const elementsNeedingSize = $(
      '[data-attachment-id]:not([data-attachment-size]):not([data-size])',
    );
    for (const element of elementsNeedingSize.toArray()) {
      const $el = $(element);
      const attachmentId = $el.attr('data-attachment-id');
      if (!attachmentId) continue;

      const processedEntry = Array.from(processed.values()).find(
        (entry) => entry.attachmentId === attachmentId,
      );

      if (processedEntry) {
        try {
          const stat = await fs.stat(processedEntry.abs);
          const sizeStr = stat.size.toString();
          const tagName = $el.prop('tagName')?.toLowerCase();
          if (tagName === 'audio' || $el.attr('data-type') === 'pdf') {
            $el.attr('data-size', sizeStr);
          } else {
            $el.attr('data-attachment-size', sizeStr);
          }
        } catch (error) {
          this.logger.debug(
            { path: processedEntry.abs, err: error },
            'Could not get file size',
          );
        }
      }
    }

    return $.root().html() || '';
  }

  private analyzeAttachments(
    attachments: AttachmentInfo[],
    isConfluenceImport?: boolean,
  ): {
    drawioPairs: Map<string, DrawioPair>;
    skipFiles: Set<string>;
  } {
    const drawioPairs = new Map<string, DrawioPair>();
    const skipFiles = new Set<string>();

    if (!isConfluenceImport) {
      return { drawioPairs, skipFiles };
    }

    const drawioFiles: AttachmentInfo[] = [];
    const pngByBaseName = new Map<string, AttachmentInfo[]>();

    const nonDrawioExtensions = new Set([
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.svg',
      '.txt',
      '.pdf',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
      '.csv',
      '.zip',
      '.tar',
      '.gz',
    ]);

    for (const attachment of attachments) {
      const { fileName, mimeType, href } = attachment;
      const fileNameLower = fileName.toLowerCase();

      if (fileName.endsWith('.tmp') || fileName.includes('~drawio~')) {
        skipFiles.add(href);
        continue;
      }

      if (mimeType === 'application/vnd.jgraph.mxfile') {
        const ext = fileNameLower.substring(fileNameLower.lastIndexOf('.'));
        if (!nonDrawioExtensions.has(ext)) {
          drawioFiles.push(attachment);
        } else {
          //Skipped non-Draw.io file with mxfile MIME.
        }
      }

      if (mimeType === 'image/png' || fileNameLower.endsWith('.png')) {
        const baseNames: string[] = [];

        if (fileName.endsWith('.drawio.png')) {
          baseNames.push(fileName.slice(0, -11));
        } else if (fileName.endsWith('.png')) {
          baseNames.push(fileName.slice(0, -4));
        }

        for (const baseName of baseNames) {
          if (!pngByBaseName.has(baseName)) {
            pngByBaseName.set(baseName, []);
          }
          pngByBaseName.get(baseName)!.push(attachment);
        }
      }
    }

    for (const drawio of drawioFiles) {
      let baseName: string;

      if (drawio.fileName.endsWith('.drawio')) {
        baseName = drawio.fileName.slice(0, -7);
      } else {
        baseName = drawio.fileName;
      }

      const candidatePngs = pngByBaseName.get(baseName) || [];
      let matchingPng: AttachmentInfo | undefined;

      const drawioIdMatch = drawio.href.match(/\/(\d+)\.\w+$/);
      const drawioId = drawioIdMatch ? drawioIdMatch[1] : null;

      if (drawioId) {
        for (const png of candidatePngs) {
          const pngIdMatch = png.href.match(/\/(\d+)\.png$/);
          const pngId = pngIdMatch ? pngIdMatch[1] : null;

          if (pngId && drawioId) {
            const idDiff = Math.abs(parseInt(pngId) - parseInt(drawioId));
            if (idDiff <= 30) {
              if (
                png.fileName === `${baseName}.drawio.png` ||
                (!drawio.fileName.endsWith('.drawio') &&
                  png.fileName === `${baseName}.png`)
              ) {
                matchingPng = png;
                break;
              }
            }
          }
        }
      }

      if (!matchingPng) {
        for (const png of candidatePngs) {
          if (png.fileName === `${baseName}.drawio.png`) {
            matchingPng = png;
            break;
          }
          if (
            !drawio.fileName.endsWith('.drawio') &&
            png.fileName === `${baseName}.png`
          ) {
            matchingPng = png;
            break;
          }
        }
      }

      if (!matchingPng) {
        this.logger.debug(
          { fileName: drawio.fileName },
          'No PNG found for Draw.io file',
        );
      }

      const pair: DrawioPair = {
        drawioFile: drawio,
        pngFile: matchingPng,
        baseName,
      };

      drawioPairs.set(drawio.href, pair);
      skipFiles.add(drawio.href);
      if (matchingPng) {
        skipFiles.add(matchingPng.href);
        const remainingPngs = pngByBaseName
          .get(baseName)
          ?.filter((png) => png.href !== matchingPng.href);
        if (remainingPngs && remainingPngs.length > 0) {
          pngByBaseName.set(baseName, remainingPngs);
        } else {
          pngByBaseName.delete(baseName);
        }
      }
    }

    return { drawioPairs, skipFiles };
  }

  private async createDrawioSvg(
    drawioPath: string,
    pngPath?: string,
  ): Promise<Buffer> {
    try {
      const drawioContent = await fs.readFile(drawioPath, 'utf-8');
      const drawioBase64 = Buffer.from(drawioContent).toString('base64');

      let imageElement = '';
      if (pngPath) {
        try {
          const pngBuffer = await fs.readFile(pngPath);
          const pngBase64 = pngBuffer.toString('base64');

          imageElement = `<image href="data:image/png;base64,${pngBase64}" width="100%" height="100%"/>`;
        } catch (error) {
          this.logger.warn(
            { pngPath, err: error },
            'Could not read PNG file for Draw.io diagram',
          );
        }
      }

      const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
      <svg xmlns="http://www.w3.org/2000/svg" 
      xmlns:xlink="http://www.w3.org/1999/xlink"
      width="600"
      height="400"
      viewBox="0 0 600 400"
      content="${drawioBase64}">${imageElement}</svg>`;

      return Buffer.from(svgContent, 'utf-8');
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to create Draw.io SVG');
      throw error;
    }
  }

  private async uploadWithRetry(opts: {
    abs: string;
    storageFilePath: string;
    attachmentId: string;
    fileNameWithExt: string;
    ext: string;
    pageId: string;
    fileTask: FileTask;
    uploadStats: {
      total: number;
      completed: number;
      failed: number;
      failedFiles: string[];
    };
  }): Promise<boolean> {
    const {
      abs,
      storageFilePath,
      attachmentId,
      fileNameWithExt,
      ext,
      pageId,
      fileTask,
      uploadStats,
    } = opts;

    let lastError: Error;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const fileStream = createReadStream(abs);
        await this.storageService.uploadStream(storageFilePath, fileStream, {
          recreateClient: true,
        });

        const stat = await fs.stat(abs);

        await this.db
          .insertInto('attachments')
          .values({
            id: attachmentId,
            filePath: storageFilePath,
            fileName: fileNameWithExt,
            fileSize: stat.size,
            mimeType: getMimeType(fileNameWithExt),
            type: 'file',
            fileExt: ext,
            creatorId: fileTask.creatorId,
            workspaceId: fileTask.workspaceId,
            pageId,
            spaceId: fileTask.spaceId,
          })
          .execute();

        const supportedExtensions = ['.pdf', '.docx'];
        if (supportedExtensions.includes(ext.toLowerCase())) {
          try {
            await this.attachmentQueue.add(
              QueueJob.ATTACHMENT_INDEX_CONTENT,
              { attachmentId },
              {
                attempts: 1,
                backoff: {
                  type: 'exponential',
                  delay: 3 * 60 * 1000,
                },
                deduplication: {
                  id: attachmentId,
                },
                removeOnComplete: true,
                removeOnFail: false,
              },
            );
          } catch (err) {
            this.logger.error(
              { attachmentId, fileName: fileNameWithExt, err },
              'Failed to queue indexing for imported attachment',
            );
          }
        }

        uploadStats.completed++;

        return true;
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(
          {
            attempt,
            maxRetries: this.MAX_RETRIES,
            fileName: fileNameWithExt,
            err: error,
          },
          'Attachment upload attempt failed',
        );

        if (attempt < this.MAX_RETRIES) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.RETRY_DELAY * attempt),
          );
        }
      }
    }

    uploadStats.failed++;
    uploadStats.failedFiles.push(fileNameWithExt);
    this.logger.error(
      {
        fileName: fileNameWithExt,
        attempts: this.MAX_RETRIES,
        err: lastError,
      },
      'Failed to upload attachment after all retries',
    );
    return false;
  }
}
