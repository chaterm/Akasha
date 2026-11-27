import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { FileTask, InsertablePage } from '@akasha/db/types/entity.types';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { load as cheerioLoad, CheerioAPI } from 'cheerio';
import * as path from 'path';
import { promises as fs } from 'fs';
import { v7 } from 'uuid';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { generateSlugId } from '../../common/helpers';
import { jsonToText } from '../../collaboration/collaboration.util';
import { getProsemirrorContent } from '../../common/helpers/prosemirror/utils';
import { executeTx } from '@akasha/db/utils';
import { KyselyTransaction } from '@akasha/db/types/kysely.types';
import { ImportService } from '../../integrations/import/services/import.service';
import {
  AttachmentInfo,
  ImportAttachmentService,
} from '../../integrations/import/services/import-attachment.service';
import { PageService } from '../../core/page/services/page.service';
import { BacklinkRepo } from '@akasha/db/repos/backlink/backlink.repo';
import { buildAttachmentCandidates } from '../../integrations/import/utils/import.utils';
import { formatImportHtml } from '../../integrations/import/utils/import-formatter';
import { EventName } from '../../common/events/event.contants';
import {
  ConfluencePageMapping,
  mergeConfluencePageMappings,
  parseConfluencePageId,
} from './confluence-page-mapping';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { transformConfluencePanels } from './confluence-panel.utils';
import { transformConfluenceFileLists } from './confluence-file-list.utils';

interface ConfluencePageNode {
  id: string;
  confluencePageId: string;
  slugId: string;
  title: string;
  filePath: string;
  parentPageId: string | null;
  position?: string;
}

const BRUSH_TO_LANGUAGE: Record<string, string> = {
  java: 'java',
  javascript: 'javascript',
  js: 'javascript',
  typescript: 'typescript',
  ts: 'typescript',
  python: 'python',
  py: 'python',
  bash: 'bash',
  shell: 'bash',
  sh: 'bash',
  sql: 'sql',
  xml: 'xml',
  html: 'html',
  css: 'css',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  go: 'go',
  golang: 'go',
  ruby: 'ruby',
  rb: 'ruby',
  php: 'php',
  csharp: 'csharp',
  'c#': 'csharp',
  cpp: 'cpp',
  'c++': 'cpp',
  c: 'c',
  rust: 'rust',
  scala: 'scala',
  kotlin: 'kotlin',
  swift: 'swift',
  groovy: 'groovy',
  powershell: 'powershell',
  ps: 'powershell',
  diff: 'diff',
  text: '',
  plain: '',
  none: '',
};

@Injectable()
export class ConfluenceImportService {
  private readonly logger = new Logger(ConfluenceImportService.name);

  constructor(
    private readonly importService: ImportService,
    private readonly importAttachmentService: ImportAttachmentService,
    private readonly pageService: PageService,
    private readonly backlinkRepo: BacklinkRepo,
    private readonly environmentService: EnvironmentService,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async processConfluenceImport(opts: {
    extractDir: string;
    fileTask: FileTask;
  }): Promise<void> {
    const { fileTask } = opts;

    const extractDir = await this.resolveContentDir(opts.extractDir);

    const pagesMap = await this.parseIndexHtml(extractDir);

    if (pagesMap.size === 0) {
      this.logger.warn(
        'No pages found in index.html, falling back to flat scan',
      );
      await this.fallbackFlatImport(extractDir, fileTask);
      return;
    }

    const attachmentCandidates = await buildAttachmentCandidates(extractDir);

    await this.assignPositions(pagesMap, fileTask.spaceId);

    const orderedPages = this.topologicalSort(pagesMap);

    if (orderedPages.length === 0) return;

    const filePathToPageMetaMap = new Map<
      string,
      { id: string; title: string; slugId: string }
    >();
    for (const page of pagesMap.values()) {
      filePathToPageMetaMap.set(page.filePath, {
        id: page.id,
        title: page.title,
        slugId: page.slugId,
      });
    }

    const space = await this.db
      .selectFrom('spaces')
      .select(['slug'])
      .where('id', '=', fileTask.spaceId)
      .executeTakeFirst();
    const appUrl = this.environmentService.getAppUrl();
    const confluenceSpaceKey = await resolveConfluenceSpaceKey(
      extractDir,
      fileTask.metadata,
    );

    const validPageIds = new Set<string>();
    const allBacklinks: any[] = [];
    const pageMappings: ConfluencePageMapping[] = [];
    let totalProcessed = 0;

    try {
      await executeTx(this.db, async (trx) => {
        for (const page of orderedPages) {
          const absPath = path.join(extractDir, page.filePath);

          let rawHtml = '';
          try {
            await fs.access(absPath);
            rawHtml = await fs.readFile(absPath, 'utf-8');
          } catch (err: any) {
            if (err?.code !== 'ENOENT') throw err;
            // 文件缺失：创建空占位页
          }

          const {
            cleanedHtml,
            pageAttachments,
            title: confluenceTitle,
          } = this.extractAndClean(rawHtml);

          const htmlWithCode = this.transformCodeBlocks(cleanedHtml);

          const htmlWithMermaid = this.transformMermaidMacros(htmlWithCode);

          const htmlWithNoformat =
            this.transformNoformatMacros(htmlWithMermaid);

          const htmlWithExpand = this.transformExpandMacros(htmlWithNoformat);

          const htmlWithCallout = this.transformInfoMacros(htmlWithExpand);

          const htmlWithStatus = this.transformStatusMacros(htmlWithCallout);

          const htmlWithSection = this.transformSectionMacros(htmlWithStatus);

          const htmlWithoutDynamic = this.stripDynamicMacros(htmlWithSection);

          const htmlWithPanels = transformConfluencePanels(htmlWithoutDynamic);

          const htmlWithInlineImages = await this.materializeDataUriImages(
            htmlWithPanels,
            extractDir,
            attachmentCandidates,
          );

          const htmlWithAttachments =
            await this.importAttachmentService.processAttachments({
              html: htmlWithInlineImages,
              pageRelativePath: page.filePath,
              extractDir,
              pageId: page.id,
              fileTask,
              attachmentCandidates,
              pageAttachments,
              isConfluenceImport: true,
            });

          const { html: finalHtml, backlinks } = await formatImportHtml({
            html: htmlWithAttachments,
            currentFilePath: page.filePath,
            filePathToPageMetaMap,
            creatorId: fileTask.creatorId,
            sourcePageId: page.id,
            workspaceId: fileTask.workspaceId,
            spaceSlug: space?.slug,
          });
          allBacklinks.push(...backlinks);

          const pmState = getProsemirrorContent(
            await this.importService.processHTML(finalHtml),
          );
          const { title, prosemirrorJson } =
            this.importService.extractTitleAndRemoveHeading(pmState);

          const insertablePage: InsertablePage = {
            id: page.id,
            slugId: page.slugId,
            title: page.title || confluenceTitle || title,
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
          validPageIds.add(page.id);
          pageMappings.push({
            confluencePageId: page.confluencePageId,
            akashaPageId: page.id,
            title: insertablePage.title ?? '',
            spaceKey: confluenceSpaceKey,
            targetUrl: buildPageUrl(appUrl, space?.slug, page.slugId),
          });
          totalProcessed++;
        }

        const filteredBacklinks = allBacklinks.filter(
          ({ sourcePageId, targetPageId }) =>
            validPageIds.has(sourcePageId) && validPageIds.has(targetPageId),
        );
        if (filteredBacklinks.length > 0) {
          const BATCH = 100;
          for (let i = 0; i < filteredBacklinks.length; i += BATCH) {
            await this.backlinkRepo.insertBacklink(
              filteredBacklinks.slice(i, i + BATCH),
              trx,
            );
          }
        }

        await this.persistLegacyPageMappings(trx, {
          workspaceId: fileTask.workspaceId,
          spaceId: fileTask.spaceId,
          importTaskId: fileTask.id,
          pageMappings,
        });

        await trx
          .updateTable('fileTasks')
          .set({
            metadata: mergeConfluencePageMappings(
              fileTask.metadata,
              pageMappings,
            ),
          })
          .where('id', '=', fileTask.id)
          .execute();
      });

      if (validPageIds.size > 0) {
        this.eventEmitter.emit(EventName.PAGE_CREATED, {
          pageIds: Array.from(validPageIds),
          workspaceId: fileTask.workspaceId,
          skipKnowledgeCompile: true,
        });
      }

      this.logger.log(
        { pagesImported: totalProcessed },
        'Confluence import complete',
      );
    } catch (err) {
      this.logger.error({ err }, 'Confluence import failed');
      throw new Error(`Confluence import failed: ${err?.['message']}`);
    }
  }

  private async resolveContentDir(extractDir: string): Promise<string> {
    const indexAtRoot = path.join(extractDir, 'index.html');
    try {
      await fs.access(indexAtRoot);
      return extractDir;
    } catch {
      // index.html 不在根目录，尝试下钻一层
    }

    const entries = await fs.readdir(extractDir, { withFileTypes: true });
    const subDirs = entries.filter((e) => e.isDirectory());

    if (subDirs.length === 1) {
      const candidate = path.join(extractDir, subDirs[0].name);
      const indexInSub = path.join(candidate, 'index.html');
      try {
        await fs.access(indexInSub);
        return candidate;
      } catch {
        // 子目录里也没有 index.html，回退
      }
    }

    return extractDir;
  }

  private async parseIndexHtml(
    extractDir: string,
  ): Promise<Map<string, ConfluencePageNode>> {
    const indexPath = path.join(extractDir, 'index.html');
    const pagesMap = new Map<string, ConfluencePageNode>();

    try {
      await fs.access(indexPath);
    } catch {
      return pagesMap;
    }

    const html = await fs.readFile(indexPath, 'utf-8');
    const $ = cheerioLoad(html);

    const processUl = (ulEl: any, parentId: string | null) => {
      $(ulEl)
        .children('li')
        .each((_, liEl) => {
          const $li = $(liEl);
          const $a = $li.children('a').first();

          if (!$a.length) return;

          const href = $a.attr('href') ?? '';
          const confluencePageId = parseConfluencePageId(href);
          if (!confluencePageId) return;

          const title = $a.text().trim();
          const filePath = href;

          const node: ConfluencePageNode = {
            id: v7(),
            confluencePageId,
            slugId: generateSlugId(),
            title,
            filePath,
            parentPageId: parentId,
          };

          pagesMap.set(filePath, node);

          $li.children('ul').each((_, childUl) => {
            processUl(childUl, node.id);
          });
        });
    };

    const $content = $('#content, .pageSection').first();
    const $rootUl = $content.find('ul').first();
    if ($rootUl.length) {
      processUl($rootUl, null);
    } else {
      $('body > div ul')
        .first()
        .each((_, ul) => processUl(ul, null));
    }

    return pagesMap;
  }

  private async assignPositions(
    pagesMap: Map<string, ConfluencePageNode>,
    spaceId: string,
  ): Promise<void> {
    const siblingsMap = new Map<string | null, ConfluencePageNode[]>();
    for (const page of pagesMap.values()) {
      const group = siblingsMap.get(page.parentPageId) ?? [];
      group.push(page);
      siblingsMap.set(page.parentPageId, group);
    }

    const rootSibs = siblingsMap.get(null);
    if (rootSibs?.length) {
      const firstPos = await this.pageService.nextPagePosition(spaceId);
      let prev: string | null = null;
      rootSibs.forEach((p, i) => {
        p.position =
          i === 0 ? firstPos : generateJitteredKeyBetween(prev, null);
        prev = p.position;
      });
    }

    for (const [parentId, sibs] of siblingsMap) {
      if (parentId === null) continue;
      let prev: string | null = null;
      for (const p of sibs) {
        p.position = generateJitteredKeyBetween(prev, null);
        prev = p.position;
      }
    }
  }

  private topologicalSort(
    pagesMap: Map<string, ConfluencePageNode>,
  ): ConfluencePageNode[] {
    const idToNode = new Map<string, ConfluencePageNode>();
    for (const node of pagesMap.values()) {
      idToNode.set(node.id, node);
    }

    const result: ConfluencePageNode[] = [];
    const visited = new Set<string>();

    const visit = (node: ConfluencePageNode) => {
      if (visited.has(node.id)) return;
      visited.add(node.id);
      if (node.parentPageId) {
        const parent = idToNode.get(node.parentPageId);
        if (parent) visit(parent);
      }
      result.push(node);
    };

    for (const node of pagesMap.values()) {
      visit(node);
    }

    return result;
  }

  private extractAndClean(rawHtml: string): {
    cleanedHtml: string;
    pageAttachments: AttachmentInfo[];
    title?: string;
  } {
    if (!rawHtml) {
      return { cleanedHtml: '', pageAttachments: [] };
    }

    const $ = cheerioLoad(rawHtml);

    const pageAttachments = this.extractAttachmentMetadata($);

    const rawTitle = $('#title-heading').text().trim().replace(/\s+/g, ' ');
    const title =
      rawTitle.length > 0 ? stripConfluenceSpacePrefix(rawTitle) : undefined;

    $('script').remove();
    $('style').remove();
    transformConfluenceFileLists($, pageAttachments);

    $('h1, h2, h3, h4, h5, h6')
      .find('a[href^="#"]')
      .each((_, el) => {
        const $a = $(el);
        $a.replaceWith($a.text());
      });

    $('#breadcrumb-section').remove();
    $('#title-heading').remove();
    $('.page-metadata').remove();
    $('#footer').remove();
    $('.footer-body').remove();
    $('h2#attachments').closest('.pageSection').remove();
    $('div.greybox').remove();

    let content = '';
    const selectors = [
      '#main-content.wiki-content',
      '.wiki-content',
      '#main-content',
      '#content',
    ];
    for (const sel of selectors) {
      const $el = $(sel).first();
      if ($el.length) {
        content = $el.html() ?? '';
        break;
      }
    }
    if (!content) {
      $('head, #header, #footer, #breadcrumbs').remove();
      content = $('body').html() ?? '';
    }

    return { cleanedHtml: content, pageAttachments, title };
  }

  private extractAttachmentMetadata($: CheerioAPI): AttachmentInfo[] {
    const attachments: AttachmentInfo[] = [];
    const seen = new Set<string>();

    $('div.greybox a[href]').each((_, el) => {
      const $a = $(el);
      const href = $a.attr('href') ?? '';
      if (!href.startsWith('attachments/')) return;

      const fileName = $a.text().trim();
      const mimeMatch = $a
        .parent()
        .text()
        .match(/\(([^)]+)\)\s*$/);
      const mimeType = mimeMatch ? mimeMatch[1].trim() : '';

      if (!seen.has(href)) {
        seen.add(href);
        attachments.push({ href, fileName, mimeType });
      }
    });

    $('img[data-linked-resource-default-alias][src]').each((_, el) => {
      const $img = $(el);
      const src = $img.attr('src') ?? '';
      if (!src.startsWith('attachments/')) return;

      const alias = $img.attr('data-linked-resource-default-alias') ?? '';
      const mimeType = $img.attr('data-linked-resource-content-type') ?? '';

      if (alias && !seen.has(src)) {
        seen.add(src);
        attachments.push({ href: src, fileName: alias, mimeType });
      } else if (alias) {
        const existing = attachments.find((a) => a.href === src);
        if (existing && !existing.fileName) {
          existing.fileName = alias;
          existing.mimeType = existing.mimeType || mimeType;
        }
      }
    });

    return attachments;
  }

  private transformCodeBlocks(html: string): string {
    if (!html) return html;

    const $ = cheerioLoad(html);

    $('div.code.panel, div.codeContent').each((_, panelEl) => {
      const $panel = $(panelEl);
      const $pre = $panel.find('pre.syntaxhighlighter-pre');
      if (!$pre.length) return;

      const params = $pre.attr('data-syntaxhighlighter-params') ?? '';
      const brushMatch = params.match(/brush\s*:\s*([^;,]+)/i);
      const brushRaw = brushMatch ? brushMatch[1].trim().toLowerCase() : '';
      const language = BRUSH_TO_LANGUAGE[brushRaw] ?? brushRaw;

      const code = $pre.text();
      const $newPre = $('<pre>');
      const $code = $('<code>').text(code);
      if (language) $code.addClass(`language-${language}`);
      $newPre.append($code);

      $panel.replaceWith($newPre);
    });

    $('pre.syntaxhighlighter-pre').each((_, preEl) => {
      const $pre = $(preEl);
      const params = $pre.attr('data-syntaxhighlighter-params') ?? '';
      const brushMatch = params.match(/brush\s*:\s*([^;,]+)/i);
      const brushRaw = brushMatch ? brushMatch[1].trim().toLowerCase() : '';
      const language = BRUSH_TO_LANGUAGE[brushRaw] ?? brushRaw;

      const code = $pre.text();
      const $newPre = $('<pre>');
      const $code = $('<code>').text(code);
      if (language) $code.addClass(`language-${language}`);
      $newPre.append($code);

      $pre.replaceWith($newPre);
    });

    return $.root().html() ?? html;
  }

  private transformMermaidMacros(html: string): string {
    if (!html) return html;

    const $ = cheerioLoad(html);

    $('div.mermaid').each((_, el) => {
      const $div = $(el);
      const code = $div.text().replace(/^\n+/, '').replace(/\s+$/, '');
      if (!code) {
        $div.remove();
        return;
      }
      const $pre = $('<pre>');
      const $code = $('<code>').addClass('language-mermaid').text(code);
      $pre.append($code);
      $div.replaceWith($pre);
    });

    return $.root().html() ?? html;
  }

  private transformNoformatMacros(html: string): string {
    if (!html) return html;

    const $ = cheerioLoad(html);

    const toCodeBlock = (text: string) => {
      const $newPre = $('<pre>');
      const $code = $('<code>').addClass('language-plaintext').text(text);
      $newPre.append($code);
      return $newPre;
    };

    $('div.preformatted').each((_, el) => {
      const $panel = $(el);
      const $pre = $panel.find('pre').first();
      if (!$pre.length) return;
      $panel.replaceWith(toCodeBlock($pre.text()));
    });

    $('pre').each((_, el) => {
      const $pre = $(el);
      if ($pre.find('code').length) return;
      $pre.replaceWith(toCodeBlock($pre.text()));
    });

    return $.root().html() ?? html;
  }

  private transformExpandMacros(html: string): string {
    if (!html) return html;

    const $ = cheerioLoad(html);

    const containers = $('div.expand-container').toArray().reverse();

    for (const el of containers) {
      const $container = $(el);

      const titleText =
        $container.find('.expand-control-text').first().text().trim() ||
        'Details';

      const $content = $container.find('div.expand-content').first();

      const $details = $('<details>').attr('open', '');
      const $summary = $('<summary>').text(titleText);
      const $detailsContent = $('<div>').attr('data-type', 'detailsContent');

      if ($content.length) {
        $detailsContent.append($content.contents());
      }

      $details.append($summary).append($detailsContent);
      $container.replaceWith($details);
    }

    return $.root().html() ?? html;
  }

  private transformInfoMacros(html: string): string {
    if (!html) return html;

    const $ = cheerioLoad(html);

    const classToType = (className: string): string => {
      if (/confluence-information-macro-tip\b/.test(className))
        return 'success';
      if (/confluence-information-macro-note\b/.test(className))
        return 'warning';
      if (/confluence-information-macro-warning\b/.test(className))
        return 'danger';
      return 'info';
    };

    const macros = $('div.confluence-information-macro').toArray().reverse();

    for (const el of macros) {
      const $macro = $(el);
      const calloutType = classToType($macro.attr('class') ?? '');

      const $callout = $('<div>')
        .attr('data-type', 'callout')
        .attr('data-callout-type', calloutType);

      const titleText = $macro.find('.title').first().text().trim();
      if (titleText) {
        const $titleP = $('<p>');
        $titleP.append($('<strong>').text(titleText));
        $callout.append($titleP);
      }

      const $body = $macro
        .find('div.confluence-information-macro-body')
        .first();
      if ($body.length) {
        $callout.append($body.contents());
      } else {
        $macro.find('span.aui-icon, .title').remove();
        $callout.append($macro.contents());
      }

      $macro.replaceWith($callout);
    }

    return $.root().html() ?? html;
  }

  private transformStatusMacros(html: string): string {
    if (!html) return html;

    const $ = cheerioLoad(html);

    const auiClassToColor = (className: string): string => {
      if (/\baui-lozenge-success\b/.test(className)) return 'green';
      if (/\baui-lozenge-error\b/.test(className)) return 'red';
      if (/\baui-lozenge-current\b/.test(className)) return 'blue';
      if (/\baui-lozenge-moved\b/.test(className)) return 'yellow';
      if (/\baui-lozenge-complete\b/.test(className)) return 'gray';
      return 'gray';
    };

    $('span.aui-lozenge').each((_, el) => {
      const $span = $(el);
      const color = auiClassToColor($span.attr('class') ?? '');
      const text = $span.text().trim();

      const $status = $('<span>')
        .attr('data-type', 'status')
        .attr('data-color', color)
        .text(text);

      $span.replaceWith($status);
    });

    return $.root().html() ?? html;
  }

  private stripDynamicMacros(html: string): string {
    if (!html) return html;

    const selectors = [
      'ul.popularlabels-list', // popular-labels:列表视图
      'div.heatmap', // popular-labels:热力图(标签云)视图
      'div.toc-macro', // toc 目录宏:目录本身,正文在其【外部】兄弟节点,可安全删除
      'nav.toc-macro', // toc 的另一种导出容器
      'div.search-macro', // livesearch 搜索框:纯交互组件(form action 指向 Confluence),导入后失效,删除
    ];
    if (!selectors.some((sel) => html.includes(sel.split('.')[1]))) {
      return html;
    }

    const $ = cheerioLoad(html);
    for (const sel of selectors) {
      $(sel).remove();
    }
    return $.root().html() ?? html;
  }

  private transformSectionMacros(html: string): string {
    if (!html) return html;
    if (!/sectionMacro|columnMacro/.test(html)) return html;

    const $ = cheerioLoad(html);

    $('div.sectionMacroRow, div.columnMacro').each((_, el) => {
      const $el = $(el);
      $el.replaceWith($el.contents());
    });
    $('div.sectionMacro').each((_, el) => {
      const $el = $(el);
      $el.replaceWith($el.contents());
    });

    return $.root().html() ?? html;
  }

  private async materializeDataUriImages(
    html: string,
    extractDir: string,
    attachmentCandidates: Map<string, string>,
  ): Promise<string> {
    if (!html || !html.includes('src="data:image')) return html;

    const $ = cheerioLoad(html);
    const imgs = $('img[src^="data:image"]').toArray();
    if (imgs.length === 0) return html;

    const dirName = 'inline-images';
    const absDir = path.join(extractDir, dirName);
    await fs.mkdir(absDir, { recursive: true });

    for (const el of imgs) {
      const $img = $(el);
      const src = $img.attr('src') ?? '';
      const match = src.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i);
      if (!match) continue;

      const ext = match[1].toLowerCase().replace('jpeg', 'jpg');
      const data = match[2];
      let buf: Buffer;
      try {
        buf = Buffer.from(data, 'base64');
      } catch {
        continue;
      }
      if (buf.length === 0) continue;

      const fileName = `${v7()}.${ext}`;
      const absPath = path.join(absDir, fileName);
      await fs.writeFile(absPath, buf);

      const relPath = `${dirName}/${fileName}`;
      attachmentCandidates.set(relPath, absPath);
      $img.attr('src', relPath);

      const $wrapper = $img.closest('div.roadmap-macro-view');
      if ($wrapper.length) {
        $wrapper.replaceWith($img);
      }
    }

    return $.root().html() ?? html;
  }

  private async fallbackFlatImport(
    extractDir: string,
    fileTask: FileTask,
  ): Promise<void> {
    const entries = await fs.readdir(extractDir, { withFileTypes: true });
    const htmlFiles = entries
      .filter(
        (e) =>
          e.isFile() && e.name.endsWith('.html') && e.name !== 'index.html',
      )
      .map((e) => e.name);

    if (htmlFiles.length === 0) return;

    const attachmentCandidates = await buildAttachmentCandidates(extractDir);
    const firstPos = await this.pageService.nextPagePosition(fileTask.spaceId);
    const space = await this.db
      .selectFrom('spaces')
      .select(['slug'])
      .where('id', '=', fileTask.spaceId)
      .executeTakeFirst();
    const appUrl = this.environmentService.getAppUrl();
    const confluenceSpaceKey = await resolveConfluenceSpaceKey(
      extractDir,
      fileTask.metadata,
    );
    const validPageIds = new Set<string>();
    const pageMappings: ConfluencePageMapping[] = [];

    await executeTx(this.db, async (trx) => {
      let prev: string | null = null;

      for (let i = 0; i < htmlFiles.length; i++) {
        const filePath = htmlFiles[i];
        const absPath = path.join(extractDir, filePath);
        const rawHtml = await fs.readFile(absPath, 'utf-8');

        const {
          cleanedHtml,
          pageAttachments,
          title: confluenceTitle,
        } = this.extractAndClean(rawHtml);
        const htmlWithCode = this.transformCodeBlocks(cleanedHtml);
        const htmlWithMermaid = this.transformMermaidMacros(htmlWithCode);
        const htmlWithNoformat = this.transformNoformatMacros(htmlWithMermaid);
        const htmlWithExpand = this.transformExpandMacros(htmlWithNoformat);
        const htmlWithCallout = this.transformInfoMacros(htmlWithExpand);
        const htmlWithStatus = this.transformStatusMacros(htmlWithCallout);
        const htmlWithSection = this.transformSectionMacros(htmlWithStatus);
        const htmlWithoutDynamic = this.stripDynamicMacros(htmlWithSection);
        const htmlWithPanels = transformConfluencePanels(htmlWithoutDynamic);
        const htmlWithInlineImages = await this.materializeDataUriImages(
          htmlWithPanels,
          extractDir,
          attachmentCandidates,
        );

        const $ = cheerioLoad(htmlWithInlineImages);
        $('a[href]').each((_, el) => {
          const href = $(el).attr('href') ?? '';
          if (/^\d+\.html$/.test(href)) $(el).removeAttr('href');
        });
        const htmlWithLinks = $.root().html() ?? htmlWithInlineImages;

        const pageId = v7();
        const htmlWithAttachments =
          await this.importAttachmentService.processAttachments({
            html: htmlWithLinks,
            pageRelativePath: filePath,
            extractDir,
            pageId,
            fileTask,
            attachmentCandidates,
            pageAttachments,
            isConfluenceImport: true,
          });

        const pmState = getProsemirrorContent(
          await this.importService.processHTML(htmlWithAttachments),
        );
        const { title, prosemirrorJson } =
          this.importService.extractTitleAndRemoveHeading(pmState);

        const position =
          i === 0 ? firstPos : generateJitteredKeyBetween(prev, null);
        prev = position;

        const titleFallback = path.basename(filePath, '.html');
        const insertablePage: InsertablePage = {
          id: pageId,
          slugId: generateSlugId(),
          title: confluenceTitle || title || titleFallback,
          content: prosemirrorJson,
          textContent: jsonToText(prosemirrorJson),
          ydoc: await this.importService.createYdoc(prosemirrorJson),
          position,
          spaceId: fileTask.spaceId,
          workspaceId: fileTask.workspaceId,
          creatorId: fileTask.creatorId,
          lastUpdatedById: fileTask.creatorId,
          parentPageId: null,
        };

        await trx.insertInto('pages').values(insertablePage).execute();
        validPageIds.add(pageId);
        const confluencePageId = parseConfluencePageId(filePath);
        if (confluencePageId) {
          pageMappings.push({
            confluencePageId,
            akashaPageId: pageId,
            title: insertablePage.title ?? '',
            spaceKey: confluenceSpaceKey,
            targetUrl: buildPageUrl(appUrl, space?.slug, insertablePage.slugId),
          });
        } else {
          this.logger.warn(
            { filePath },
            'Cannot map non-numeric Confluence HTML file',
          );
        }
      }

      await this.persistLegacyPageMappings(trx, {
        workspaceId: fileTask.workspaceId,
        spaceId: fileTask.spaceId,
        importTaskId: fileTask.id,
        pageMappings,
      });

      await trx
        .updateTable('fileTasks')
        .set({
          metadata: mergeConfluencePageMappings(
            fileTask.metadata,
            pageMappings,
          ),
        })
        .where('id', '=', fileTask.id)
        .execute();
    });

    if (validPageIds.size > 0) {
      this.eventEmitter.emit(EventName.PAGE_CREATED, {
        pageIds: Array.from(validPageIds),
        workspaceId: fileTask.workspaceId,
        skipKnowledgeCompile: true,
      });
    }
  }

  private async persistLegacyPageMappings(
    trx: KyselyTransaction,
    input: {
      workspaceId: string;
      spaceId: string;
      importTaskId: string;
      pageMappings: ConfluencePageMapping[];
    },
  ): Promise<void> {
    if (input.pageMappings.length === 0) return;

    await trx
      .insertInto('legacyLinkMappings')
      .values(
        input.pageMappings.map((mapping) => ({
          workspaceId: input.workspaceId,
          source: 'confluence',
          legacySpaceKey: mapping.spaceKey ?? null,
          legacyPageId: mapping.confluencePageId,
          legacyTitle: mapping.title,
          legacyPath: `/pages/viewpage.action?pageId=${mapping.confluencePageId}`,
          targetSpaceId: input.spaceId,
          targetPageId: mapping.akashaPageId,
          targetUrl: mapping.targetUrl,
          importTaskId: input.importTaskId,
        })),
      )
      .onConflict((oc) =>
        oc
          .columns(['workspaceId', 'source', 'legacyPageId'])
          .doUpdateSet((eb) => ({
            legacySpaceKey: eb.ref('excluded.legacySpaceKey'),
            legacyTitle: eb.ref('excluded.legacyTitle'),
            legacyPath: eb.ref('excluded.legacyPath'),
            targetSpaceId: eb.ref('excluded.targetSpaceId'),
            targetPageId: eb.ref('excluded.targetPageId'),
            targetUrl: eb.ref('excluded.targetUrl'),
            importTaskId: eb.ref('excluded.importTaskId'),
            updatedAt: new Date(),
          })),
      )
      .execute();
  }
}

function stripConfluenceSpacePrefix(rawTitle: string): string {
  const sepIndex = rawTitle.indexOf(' : ');
  if (sepIndex === -1) return rawTitle;
  const stripped = rawTitle.slice(sepIndex + 3).trim();
  return stripped.length > 0 ? stripped : rawTitle;
}

function buildPageUrl(
  appUrl: string,
  spaceSlug: string | undefined,
  pageSlugId: string,
): string {
  const prefix = appUrl.replace(/\/+$/, '');
  return spaceSlug
    ? `${prefix}/s/${spaceSlug}/p/${pageSlugId}`
    : `${prefix}/p/${pageSlugId}`;
}

async function resolveConfluenceSpaceKey(
  extractDir: string,
  metadata: FileTask['metadata'],
): Promise<string | undefined> {
  const metadataSpaceKey = getConfluenceSpaceKey(metadata);
  if (metadataSpaceKey) return metadataSpaceKey;

  const indexPath = path.join(extractDir, 'index.html');
  try {
    await fs.access(indexPath);
  } catch {
    return undefined;
  }

  const html = await fs.readFile(indexPath, 'utf-8');
  const $ = cheerioLoad(html);
  const hiddenSpaceKey = $('input[name="spaceKey"]').first().attr('value');
  const fromHidden = String(hiddenSpaceKey ?? '').trim();
  if (fromHidden) return fromHidden;

  let tableSpaceKey: string | undefined;
  $('table tr').each((_, tr) => {
    if (tableSpaceKey) return;
    const $tr = $(tr);
    const label = $tr.children('th').first().text().trim().toLowerCase();
    if (label !== 'key') return;
    const value = $tr.children('td').first().text().trim();
    if (value) tableSpaceKey = value;
  });

  return tableSpaceKey;
}

function getConfluenceSpaceKey(
  metadata: FileTask['metadata'],
): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const confluence = metadata.confluence;
  if (
    !confluence ||
    typeof confluence !== 'object' ||
    Array.isArray(confluence)
  ) {
    return undefined;
  }
  const spaceKey = String(confluence.spaceKey ?? '').trim();
  return spaceKey.length > 0 ? spaceKey : undefined;
}
