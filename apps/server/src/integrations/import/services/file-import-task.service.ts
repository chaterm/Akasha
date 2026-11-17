import { Inject, Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import { jsonToText } from '../../../collaboration/collaboration.util';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import {
  extractZip,
  FileImportSource,
  FileTaskStatus,
} from '../utils/file.utils';
import { StorageService } from '../../storage/storage.service';
import * as tmp from 'tmp-promise';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { ImportService } from './import.service';
import { promises as fs } from 'fs';
import { generateSlugId } from '../../../common/helpers';
import { v7 } from 'uuid';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { FileTask, InsertablePage } from '@akasha/db/types/entity.types';
import { markdownToHtml } from '@docmost/editor-ext';
import { getProsemirrorContent } from '../../../common/helpers/prosemirror/utils';
import { formatImportHtml } from '../utils/import-formatter';
import {
  buildAttachmentCandidates,
  collectMarkdownAndHtmlFiles,
  encodeFilePath,
  extractNotionPartialId,
  readDocmostMetadata,
  stripNotionID,
} from '../utils/import.utils';
import { executeTx } from '@akasha/db/utils';
import { BacklinkRepo } from '@akasha/db/repos/backlink/backlink.repo';
import { ImportAttachmentService } from './import-attachment.service';
import { ModuleRef } from '@nestjs/core';
import { PageService } from '../../../core/page/services/page.service';
import { ImportPageNode } from '../dto/file-task-dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventName } from '../../../common/events/event.contants';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';

@Injectable()
export class FileImportTaskService {
  private readonly logger = new Logger(FileImportTaskService.name);

  constructor(
    private readonly storageService: StorageService,
    private readonly importService: ImportService,
    private readonly pageService: PageService,
    private readonly backlinkRepo: BacklinkRepo,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly importAttachmentService: ImportAttachmentService,
    private moduleRef: ModuleRef,
    private eventEmitter: EventEmitter2,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async processZIpImport(fileTaskId: string): Promise<void> {
    const fileTask = await this.db
      .selectFrom('fileTasks')
      .selectAll()
      .where('id', '=', fileTaskId)
      .executeTakeFirst();

    if (!fileTask) {
      this.logger.log({ fileTaskId }, 'Import file task not found');
      return;
    }

    if (fileTask.status === FileTaskStatus.Failed) {
      return;
    }

    if (fileTask.status === FileTaskStatus.Success) {
      this.logger.log('Imported task already processed.');
      return;
    }

    const { path: tmpZipPath, cleanup: cleanupTmpFile } = await tmp.file({
      prefix: 'akasha-import',
      postfix: '.zip',
      discardDescriptor: true,
    });

    const { path: tmpExtractDir, cleanup: cleanupTmpDir } = await tmp.dir({
      prefix: 'akasha-extract-',
      unsafeCleanup: true,
    });

    try {
      const fileStream = await this.storageService.readStream(
        fileTask.filePath,
      );
      await pipeline(fileStream, createWriteStream(tmpZipPath));
      await extractZip(tmpZipPath, tmpExtractDir);
    } catch (err) {
      await cleanupTmpFile();
      await cleanupTmpDir();

      throw err;
    }

    try {
      if (
        fileTask.source === FileImportSource.Generic ||
        fileTask.source === FileImportSource.Notion
      ) {
        await this.processGenericImport({
          extractDir: tmpExtractDir,
          fileTask,
        });
      }

      if (fileTask.source === FileImportSource.Confluence) {
        let ConfluenceModule: any;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          ConfluenceModule = require('./../../../features/confluence-import/confluence-import.service');
        } catch (err) {
          this.logger.error(
            'Confluence import requested but EE module not bundled in this build',
          );
          return;
        }
        const confluenceImportService = this.moduleRef.get(
          ConfluenceModule.ConfluenceImportService,
          { strict: false },
        );

        await confluenceImportService.processConfluenceImport({
          extractDir: tmpExtractDir,
          fileTask,
        });
      }
      try {
        await this.updateTaskStatus(fileTaskId, FileTaskStatus.Success, null);
        await cleanupTmpFile();
        await cleanupTmpDir();
        await this.storageService.delete(fileTask.filePath);
      } catch (err) {
        this.logger.error(
          { fileTaskId, err },
          'Failed to delete import file from storage',
        );
      }
    } catch (err) {
      await cleanupTmpFile();
      await cleanupTmpDir();

      throw err;
    }
  }

  async processGenericImport(opts: {
    extractDir: string;
    fileTask: FileTask;
  }): Promise<void> {
    const { extractDir, fileTask } = opts;
    const isNotion = fileTask.source === FileImportSource.Notion;
    const allFiles = await collectMarkdownAndHtmlFiles(extractDir);
    const attachmentCandidates = await buildAttachmentCandidates(extractDir);
    const docmostMetadata = await readDocmostMetadata(extractDir);

    const space = await this.db
      .selectFrom('spaces')
      .select(['slug'])
      .where('id', '=', fileTask.spaceId)
      .executeTakeFirst();

    const pagesMap = new Map<string, ImportPageNode>();

    for (const absPath of allFiles) {
      const relPath = path
        .relative(extractDir, absPath)
        .split(path.sep)
        .join('/');
      const ext = path.extname(relPath).toLowerCase();

      const encodedPath = encodeFilePath(relPath);
      const pageMetadata = docmostMetadata?.pages[encodedPath];

      pagesMap.set(relPath, {
        id: v7(),
        slugId: generateSlugId(),
        name: stripNotionID(path.basename(relPath, ext)),
        content: '',
        parentPageId: null,
        fileExtension: ext,
        filePath: relPath,
        icon: pageMetadata?.icon ?? null,
      });
    }

    const foldersWithContent = new Set<string>();

    pagesMap.forEach((page) => {
      const segments = page.filePath.split('/');
      segments.pop();

      let currentPath = '';
      for (const segment of segments) {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        foldersWithContent.add(currentPath);
      }
    });

    const rootLevelItems = new Set<string>();
    pagesMap.forEach((page) => {
      const firstSegment = page.filePath.split('/')[0];
      rootLevelItems.add(firstSegment);
    });

    let skipRootFolder: string | null = null;
    if (rootLevelItems.size === 1) {
      const onlyRootItem = Array.from(rootLevelItems)[0];
      const hasRootFiles = Array.from(pagesMap.keys()).some(
        (filePath) => !filePath.includes('/'),
      );
      if (!hasRootFiles) {
        skipRootFolder = onlyRootItem;
      }
    }

    const sortedFolders = isNotion
      ? [...foldersWithContent].sort((a, b) => {
          const aHasPartial = extractNotionPartialId(path.basename(a)) ? 0 : 1;
          const bHasPartial = extractNotionPartialId(path.basename(b)) ? 0 : 1;
          return aHasPartial - bHasPartial;
        })
      : [...foldersWithContent];

    sortedFolders.forEach((folderPath) => {
      if (
        skipRootFolder &&
        folderPath?.toLowerCase() === skipRootFolder?.toLowerCase()
      ) {
        return;
      }

      const mdPath = `${folderPath}.md`;
      const htmlPath = `${folderPath}.html`;

      if (!pagesMap.has(mdPath) && !pagesMap.has(htmlPath)) {
        const folderName = path.basename(folderPath);
        const parentDir = path.dirname(folderPath);

        let matched = false;
        if (isNotion) {
          const partialId = extractNotionPartialId(folderName);
          const strippedFolderName = stripNotionID(folderName);
          const isSameDir = (fileDir: string) =>
            fileDir === parentDir ||
            (parentDir === '.' && !fileDir.includes('/'));

          for (const [filePath, page] of pagesMap.entries()) {
            if (!isSameDir(path.dirname(filePath))) continue;
            if (page.name !== strippedFolderName) continue;

            if (partialId) {
              const fileBase = path.basename(filePath, path.extname(filePath));
              const fullIdMatch = fileBase.match(/[a-f0-9]{32}$/i);
              if (!fullIdMatch) continue;
              const fullId = fullIdMatch[0].toLowerCase();
              if (
                !fullId.startsWith(partialId.prefix) ||
                !fullId.endsWith(partialId.suffix)
              ) {
                continue;
              }
            }

            pagesMap.delete(filePath);
            page.filePath = mdPath;
            pagesMap.set(mdPath, page);
            matched = true;
            break;
          }
        }

        if (!matched) {
          const encodedMdPath = encodeFilePath(mdPath);
          const placeholderMetadata = docmostMetadata?.pages[encodedMdPath];
          pagesMap.set(mdPath, {
            id: v7(),
            slugId: generateSlugId(),
            name: stripNotionID(folderName),
            content: '',
            parentPageId: null,
            fileExtension: '.md',
            filePath: mdPath,
            icon: placeholderMetadata?.icon ?? null,
          });
        }
      }
    });

    pagesMap.forEach((page, filePath) => {
      const segments = filePath.split('/');
      segments.pop();
      let parentPage = null;
      while (segments.length) {
        const tryMd = segments.join('/') + '.md';
        const tryHtml = segments.join('/') + '.html';
        if (pagesMap.has(tryMd)) {
          parentPage = pagesMap.get(tryMd)!;
          break;
        }
        if (pagesMap.has(tryHtml)) {
          parentPage = pagesMap.get(tryHtml)!;
          break;
        }
        segments.pop();
      }
      if (parentPage) page.parentPageId = parentPage.id;
    });

    const siblingsMap = new Map<string | null, ImportPageNode[]>();

    pagesMap.forEach((page) => {
      const group = siblingsMap.get(page.parentPageId) ?? [];
      group.push(page);
      siblingsMap.set(page.parentPageId, group);
    });

    const encodedPathsMap = new Map<string, string>();
    if (docmostMetadata) {
      pagesMap.forEach((_, filePath) => {
        encodedPathsMap.set(filePath, encodeFilePath(filePath));
      });
    }

    const sortSiblings = (siblings: ImportPageNode[]) => {
      if (docmostMetadata) {
        siblings.sort((a, b) => {
          const posA =
            docmostMetadata.pages[encodedPathsMap.get(a.filePath)]?.position;
          const posB =
            docmostMetadata.pages[encodedPathsMap.get(b.filePath)]?.position;
          if (posA && posB) {
            if (posA < posB) return -1;
            if (posA > posB) return 1;
            return 0;
          }
          return a.name.localeCompare(b.name);
        });
      } else {
        siblings.sort((a, b) => a.name.localeCompare(b.name));
      }
    };

    const rootSibs = siblingsMap.get(null);

    if (rootSibs?.length) {
      sortSiblings(rootSibs);

      const nextPosition = await this.pageService.nextPagePosition(
        fileTask.spaceId,
      );

      let prevPos: string | null = null;
      rootSibs.forEach((page, idx) => {
        if (idx === 0) {
          page.position = nextPosition;
        } else {
          page.position = generateJitteredKeyBetween(prevPos, null);
        }
        prevPos = page.position;
      });
    }

    siblingsMap.forEach((sibs, parentId) => {
      if (parentId === null) return;

      sortSiblings(sibs);

      let prevPos: string | null = null;
      for (const page of sibs) {
        page.position = generateJitteredKeyBetween(prevPos, null);
        prevPos = page.position;
      }
    });

    const filePathToPageMetaMap = new Map<
      string,
      { id: string; title: string; slugId: string }
    >();
    pagesMap.forEach((page) => {
      filePathToPageMetaMap.set(page.filePath, {
        id: page.id,
        title: page.name,
        slugId: page.slugId,
      });
    });

    const pagesByLevel = new Map<number, Array<[string, ImportPageNode]>>();
    const pageLevel = new Map<string, number>();

    const calculateLevels = () => {
      const queue: Array<{ filePath: string; level: number }> = [];

      for (const [filePath, page] of pagesMap.entries()) {
        if (!page.parentPageId) {
          queue.push({ filePath, level: 0 });
          pageLevel.set(filePath, 0);
        }
      }

      while (queue.length > 0) {
        const { filePath, level } = queue.shift()!;
        const currentPage = pagesMap.get(filePath)!;

        for (const [childFilePath, childPage] of pagesMap.entries()) {
          if (
            childPage.parentPageId === currentPage.id &&
            !pageLevel.has(childFilePath)
          ) {
            pageLevel.set(childFilePath, level + 1);
            queue.push({ filePath: childFilePath, level: level + 1 });
          }
        }
      }

      for (const [filePath, page] of pagesMap.entries()) {
        const level = pageLevel.get(filePath) || 0;
        if (!pagesByLevel.has(level)) {
          pagesByLevel.set(level, []);
        }
        pagesByLevel.get(level)!.push([filePath, page]);
      }
    };

    calculateLevels();

    if (pagesMap.size < 1) return;

    const allBacklinks: any[] = [];
    const validPageIds = new Set<string>();
    const pageTitles = new Map<string, string>();
    let totalPagesProcessed = 0;

    const sortedLevels = Array.from(pagesByLevel.keys()).sort((a, b) => a - b);

    try {
      await executeTx(this.db, async (trx) => {
        for (const level of sortedLevels) {
          const levelPages = pagesByLevel.get(level)!;

          for (const [filePath, page] of levelPages) {
            const absPath = path.join(extractDir, filePath);
            let content = '';

            try {
              await fs.access(absPath);
              content = await fs.readFile(absPath, 'utf-8');

              if (page.fileExtension.toLowerCase() === '.md') {
                content = await markdownToHtml(content);
              }
            } catch (err: any) {
              if (err?.code === 'ENOENT') {
                content = '';
              } else {
                throw err;
              }
            }

            const htmlContent =
              await this.importAttachmentService.processAttachments({
                html: content,
                pageRelativePath: page.filePath,
                extractDir,
                pageId: page.id,
                fileTask,
                attachmentCandidates,
              });

            const { html, backlinks, pageIcon } = await formatImportHtml({
              html: htmlContent,
              currentFilePath: page.filePath,
              filePathToPageMetaMap: filePathToPageMetaMap,
              creatorId: fileTask.creatorId,
              sourcePageId: page.id,
              workspaceId: fileTask.workspaceId,
              spaceSlug: space?.slug,
            });

            const pmState = getProsemirrorContent(
              await this.importService.processHTML(html),
            );

            const { title, prosemirrorJson } =
              this.importService.extractTitleAndRemoveHeading(pmState);

            const insertablePage: InsertablePage = {
              id: page.id,
              slugId: page.slugId,
              title: title || page.name,
              icon: page.icon || pageIcon || null,
              content: prosemirrorJson,
              textContent: jsonToText(prosemirrorJson),
              ydoc: await this.importService.createYdoc(prosemirrorJson),
              position: page.position!,
              spaceId: fileTask.spaceId,
              workspaceId: fileTask.workspaceId,
              creatorId: fileTask.creatorId,
              lastUpdatedById: fileTask.creatorId,
              parentPageId: page.parentPageId,
            };

            await trx.insertInto('pages').values(insertablePage).execute();

            validPageIds.add(insertablePage.id);
            pageTitles.set(insertablePage.id, insertablePage.title);
            allBacklinks.push(...backlinks);
            totalPagesProcessed++;
          }
        }

        const filteredBacklinks = allBacklinks.filter(
          ({ sourcePageId, targetPageId }) =>
            validPageIds.has(sourcePageId) && validPageIds.has(targetPageId),
        );

        if (filteredBacklinks.length > 0) {
          const BACKLINK_BATCH_SIZE = 100;
          for (
            let i = 0;
            i < filteredBacklinks.length;
            i += BACKLINK_BATCH_SIZE
          ) {
            const backlinkChunk = filteredBacklinks.slice(
              i,
              Math.min(i + BACKLINK_BATCH_SIZE, filteredBacklinks.length),
            );
            await this.backlinkRepo.insertBacklink(backlinkChunk, trx);
          }
        }

        if (validPageIds.size > 0) {
          this.eventEmitter.emit(EventName.PAGE_CREATED, {
            pageIds: Array.from(validPageIds),
            workspaceId: fileTask.workspaceId,
            skipKnowledgeCompile: true,
          });
        }

        this.logger.log(
          {
            pagesImported: totalPagesProcessed,
            backlinks: filteredBacklinks.length,
          },
          'Import completed',
        );
      });

      if (validPageIds.size > 0) {
        const auditPayloads = Array.from(validPageIds).map((pageId) => ({
          event: AuditEvent.PAGE_CREATED,
          resourceType: AuditResource.PAGE,
          resourceId: pageId,
          spaceId: fileTask.spaceId,
          metadata: {
            source: fileTask.source,
            fileTaskId: fileTask.id,
            title: pageTitles.get(pageId),
          },
        }));

        this.auditService.logBatchWithContext(auditPayloads, {
          workspaceId: fileTask.workspaceId,
          actorId: fileTask.creatorId,
          actorType: 'user',
        });
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to import files');
      throw new Error(`File import failed: ${error?.['message']}`);
    }
  }

  async getFileTask(fileTaskId: string) {
    return this.db
      .selectFrom('fileTasks')
      .selectAll()
      .where('id', '=', fileTaskId)
      .executeTakeFirst();
  }

  async updateTaskStatus(
    fileTaskId: string,
    status: FileTaskStatus,
    errorMessage?: string,
  ) {
    try {
      await this.db
        .updateTable('fileTasks')
        .set({ status: status, errorMessage, updatedAt: new Date() })
        .where('id', '=', fileTaskId)
        .execute();
    } catch (err) {
      this.logger.error(err);
    }
  }
}
