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
import { ImportService } from '../../integrations/import/services/import.service';
import { ImportAttachmentService } from '../../integrations/import/services/import-attachment.service';
import { PageService } from '../../core/page/services/page.service';
import { BacklinkRepo } from '@akasha/db/repos/backlink/backlink.repo';
import {
  buildAttachmentCandidates,
} from '../../integrations/import/utils/import.utils';
import { formatImportHtml } from '../../integrations/import/utils/import-formatter';
import { EventName } from '../../common/events/event.contants';
import {
  ConfluencePageMapping,
  mergeConfluencePageMappings,
  parseConfluencePageId,
} from './confluence-page-mapping';

interface ConfluencePageNode {
  id: string;
  confluencePageId: string;
  slugId: string;
  title: string;
  filePath: string;       // 相对 extractDir 的路径，如 "7320321.html"
  parentPageId: string | null;
  position?: string;
}

interface AttachmentInfo {
  href: string;
  fileName: string;
  mimeType: string;
}

// brush 语言名称 → highlight.js 语言标识符
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
    @InjectKysely() private readonly db: KyselyDB,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async processConfluenceImport(opts: {
    extractDir: string;
    fileTask: FileTask;
  }): Promise<void> {
    const { fileTask } = opts;

    // ZIP 解压后可能带一层目录前缀（如 "xxx@xxxxxx.net/"），
    // 探测并下钻到真正包含 index.html 的目录
    const extractDir = await this.resolveContentDir(opts.extractDir);

    // Step 1: 从 index.html 解析层级树
    const pagesMap = await this.parseIndexHtml(extractDir);

    if (pagesMap.size === 0) {
      this.logger.warn(
        'No pages found in index.html, falling back to flat scan',
      );
      await this.fallbackFlatImport(extractDir, fileTask);
      return;
    }

    // Step 2: 构建附件候选表
    const attachmentCandidates = await buildAttachmentCandidates(extractDir);

    // Step 3: 生成位置键
    await this.assignPositions(pagesMap, fileTask.spaceId);

    // Step 4: 按层级排序（父页面先于子页面写入，满足外键约束）
    const orderedPages = this.topologicalSort(pagesMap);

    if (orderedPages.length === 0) return;

    // 构建 filePath → 页面元数据 的映射，供内部链接转换使用
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

          // 提取正文并清理，同时收集附件元数据 + Confluence 权威标题
          const {
            cleanedHtml,
            pageAttachments,
            title: confluenceTitle,
          } = this.extractAndClean(rawHtml);

          // 转换代码块
          const htmlWithCode = this.transformCodeBlocks(cleanedHtml);

          // 调用现有附件处理（上传图片/附件，替换路径）
          const htmlWithAttachments =
            await this.importAttachmentService.processAttachments({
              html: htmlWithCode,
              pageRelativePath: page.filePath,
              extractDir,
              pageId: page.id,
              fileTask,
              attachmentCandidates,
              pageAttachments,
              isConfluenceImport: true,
            });

          // 内部链接转换 + normalizeImportHtml（顺序与 generic import 一致：
          // normalizeImportHtml 先跑把外部链接转 embed，再转内部链接为 mention）
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

          // 转换为 ProseMirror
          const pmState = getProsemirrorContent(
            await this.importService.processHTML(finalHtml),
          );
          const { title, prosemirrorJson } =
            this.importService.extractTitleAndRemoveHeading(pmState);

          const insertablePage: InsertablePage = {
            id: page.id,
            slugId: page.slugId,
            // 优先级:index.html 导航文本(page.title)→ #title-heading 权威标题(剥 space 前缀)
            //         → 正文首个 H1(罕见)。前两者通常一致,但主路径下 page.title 已干净,优先。
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
          });
          totalProcessed++;

          if (totalProcessed % 50 === 0) {
            this.logger.debug(`Processed ${totalProcessed} pages...`);
          }
        }

        // 写入 backlinks（只保留双端页面都存在的）
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
        });
      }

      this.logger.log(
        `Confluence import complete: ${totalProcessed} pages imported`,
      );
    } catch (err) {
      this.logger.error('Confluence import failed', err);
      throw new Error(`Confluence import failed: ${err?.['message']}`);
    }
  }

  // ─── 目录探测：下钻到真正包含 index.html 的目录 ──────────────────────────

  private async resolveContentDir(extractDir: string): Promise<string> {
    // 先检查 extractDir 本身
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
      // 只有一个子目录时，下钻进去（典型：zip 带了目录名前缀）
      const candidate = path.join(extractDir, subDirs[0].name);
      const indexInSub = path.join(candidate, 'index.html');
      try {
        await fs.access(indexInSub);
        this.logger.debug(
          `Resolved content dir: ${subDirs[0].name}/`,
        );
        return candidate;
      } catch {
        // 子目录里也没有 index.html，回退
      }
    }

    return extractDir;
  }

  // ─── Step 1: 解析 index.html ──────────────────────────────────────────────

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

    // 递归遍历 ul > li > a，建立父子关系
    const processUl = (ulEl: any, parentId: string | null) => {
      // 只取直接子 li，避免递归进入嵌套 ul
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
          const filePath = href; // "7320321.html"

          const node: ConfluencePageNode = {
            id: v7(),
            confluencePageId,
            slugId: generateSlugId(),
            title,
            filePath,
            parentPageId: parentId,
          };

          pagesMap.set(filePath, node);

          // 递归处理子 ul
          $li.children('ul').each((_, childUl) => {
            processUl(childUl, node.id);
          });
        });
    };

    // 从 #content 或 body 里找第一层 ul
    const $content = $('#content, .pageSection').first();
    const $rootUl = $content.find('ul').first();
    if ($rootUl.length) {
      processUl($rootUl, null);
    } else {
      // 兜底：直接从 body 找
      $('body > div ul').first().each((_, ul) => processUl(ul, null));
    }

    this.logger.debug(`Parsed ${pagesMap.size} pages from index.html`);
    return pagesMap;
  }

  // ─── Step 3: 位置键 ───────────────────────────────────────────────────────

  private async assignPositions(
    pagesMap: Map<string, ConfluencePageNode>,
    spaceId: string,
  ): Promise<void> {
    // 按父节点分组同级页面
    const siblingsMap = new Map<string | null, ConfluencePageNode[]>();
    for (const page of pagesMap.values()) {
      const group = siblingsMap.get(page.parentPageId) ?? [];
      group.push(page);
      siblingsMap.set(page.parentPageId, group);
    }

    // 根级页面：从服务端获取起始位置
    const rootSibs = siblingsMap.get(null);
    if (rootSibs?.length) {
      const firstPos = await this.pageService.nextPagePosition(spaceId);
      let prev: string | null = null;
      rootSibs.forEach((p, i) => {
        p.position = i === 0 ? firstPos : generateJitteredKeyBetween(prev, null);
        prev = p.position;
      });
    }

    // 非根级
    for (const [parentId, sibs] of siblingsMap) {
      if (parentId === null) continue;
      let prev: string | null = null;
      for (const p of sibs) {
        p.position = generateJitteredKeyBetween(prev, null);
        prev = p.position;
      }
    }
  }

  // ─── Step 4: 拓扑排序（父先于子）────────────────────────────────────────────

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

  // ─── Step 3a+3b: 提取正文 + 清理 + 收集附件元数据 ────────────────────────

  private extractAndClean(rawHtml: string): {
    cleanedHtml: string;
    pageAttachments: AttachmentInfo[];
    // 从 Confluence 导出 HTML 的 #title-heading 容器里提取的权威页面标题。
    // Confluence 导出时把页面标题专门放在 <h1 id="title-heading"> 里(常嵌一个
    // <a href="...">真实标题</a>)。后续要把这个容器整个删除作为 UI 噪音处理,
    // 但要在删之前先把标题文本抽出来传给上层 —— 否则 fallback 路径会用文件名
    // (纯数字 page id)兜底,变成数字标题。
    title?: string;
  } {
    if (!rawHtml) {
      return { cleanedHtml: '', pageAttachments: [] };
    }

    const $ = cheerioLoad(rawHtml);

    // 先从附件区提取元数据（greybox 在下面会被删除）
    const pageAttachments = this.extractAttachmentMetadata($);

    // 在删除 #title-heading 前先抽出其中的标题文本(作为权威 title)。
    // .text() 会自动剥离 <a>/<span> 等内层结构,直接得到纯文本。
    // 经 stripConfluenceSpacePrefix 剥掉 space 名前缀(如 "AIM-运维-知识库 : ")。
    // 空白返回 undefined,让上层走 page.title / extractTitleAndRemoveHeading 兜底。
    const rawTitle = $('#title-heading').text().trim().replace(/\s+/g, ' ');
    const title =
      rawTitle.length > 0 ? stripConfluenceSpacePrefix(rawTitle) : undefined;

    // 移除 Confluence UI 噪音
    $('#breadcrumb-section').remove();
    $('#title-heading').remove();
    $('.page-metadata').remove();
    $('#footer').remove();
    $('.footer-body').remove();
    // 附件列表区（h2#attachments + 后面的 greybox）
    $('h2#attachments').closest('.pageSection').remove();
    $('div.greybox').remove();

    // 提取正文区域（按优先级顺序查找，cheerio 空集合是 truthy 不能用 ||）
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
      // 兜底：移除 header/footer 后取 body
      $('head, #header, #footer, #breadcrumbs').remove();
      content = $('body').html() ?? '';
    }

    return { cleanedHtml: content, pageAttachments, title };
  }

  private extractAttachmentMetadata($: CheerioAPI): AttachmentInfo[] {
    const attachments: AttachmentInfo[] = [];
    const seen = new Set<string>();

    // 从附件清单区提取（greybox 里的 <a href="attachments/..."> 文本 (mime/type)）
    $('div.greybox a[href]').each((_, el) => {
      const $a = $(el);
      const href = $a.attr('href') ?? '';
      if (!href.startsWith('attachments/')) return;

      const fileName = $a.text().trim();
      // mime 类型在链接后的文本节点里，如 " (image/png)"
      const mimeMatch = $a.parent().text().match(/\(([^)]+)\)\s*$/);
      const mimeType = mimeMatch ? mimeMatch[1].trim() : '';

      if (!seen.has(href)) {
        seen.add(href);
        attachments.push({ href, fileName, mimeType });
      }
    });

    // 补充：从 img 的 data-linked-resource-default-alias 取原始文件名
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
        // 已在 greybox 里登记过，但文件名可能是 resourceId.ext，用 alias 更新
        const existing = attachments.find((a) => a.href === src);
        if (existing && !existing.fileName) {
          existing.fileName = alias;
          existing.mimeType = existing.mimeType || mimeType;
        }
      }
    });

    return attachments;
  }

  // ─── Step 3c: 代码块转换 ─────────────────────────────────────────────────

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

    // 兜底：未被 code panel 包裹的裸 syntaxhighlighter-pre
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

  // ─── 降级：无 index.html 时平铺导入 ─────────────────────────────────────

  private async fallbackFlatImport(
    extractDir: string,
    fileTask: FileTask,
  ): Promise<void> {
    const entries = await fs.readdir(extractDir, { withFileTypes: true });
    const htmlFiles = entries
      .filter(
        (e) =>
          e.isFile() &&
          e.name.endsWith('.html') &&
          e.name !== 'index.html',
      )
      .map((e) => e.name);

    if (htmlFiles.length === 0) return;

    const attachmentCandidates = await buildAttachmentCandidates(extractDir);
    const firstPos = await this.pageService.nextPagePosition(fileTask.spaceId);
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

        // fallback 路径无层级映射，移除内部链接 href 避免被误转成 embed
        const $ = cheerioLoad(htmlWithCode);
        $('a[href]').each((_, el) => {
          const href = $(el).attr('href') ?? '';
          if (/^\d+\.html$/.test(href)) $(el).removeAttr('href');
        });
        const htmlWithLinks = $.root().html() ?? htmlWithCode;

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
          // 优先级:Confluence #title-heading(权威,剥 space 前缀)→ 正文首个 H1 → 文件名(纯数字 ID)兜底。
          // 修复"文件名数字被当成标题"的 bug —— #title-heading 删除前已先抽出。
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
          });
        } else {
          this.logger.warn(
            `Cannot map non-numeric Confluence HTML file: ${filePath}`,
          );
        }
      }

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
      });
    }
  }
}

/**
 * 剥掉 Confluence #title-heading 文本里 space 名前缀。
 *
 * Confluence 导出时,#title-heading 的内容通常是 "<spaceName> : <pageName>"
 * (如 "AIM-运维-知识库 : Amazon S3 清单分析")。展示时只要页面名更干净,
 * 这跟 index.html 导航 <a> 的纯文本一致。
 *
 * 保守剥取策略:
 *   - 仅当含 " : " 分隔符且后半段非空时才剥(避免误剥本身就含冒号的标题,
 *     比如本意就是 "1: 介绍" 这种格式)。
 *   - 只剥第一个 " : ",保留后续冒号(子层级标题里可能有更多冒号)。
 *   - 取不到合理结果则返回原值,绝不返回空串覆盖掉权威 title。
 */
function stripConfluenceSpacePrefix(rawTitle: string): string {
  const sepIndex = rawTitle.indexOf(' : ');
  if (sepIndex === -1) return rawTitle;
  const stripped = rawTitle.slice(sepIndex + 3).trim();
  return stripped.length > 0 ? stripped : rawTitle;
}
