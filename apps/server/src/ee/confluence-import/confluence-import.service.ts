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
import { ImportAttachmentService } from '../../integrations/import/services/import-attachment.service';
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

interface ConfluencePageNode {
  id: string;
  confluencePageId: string;
  slugId: string;
  title: string;
  filePath: string; // 相对 extractDir 的路径，如 "7320321.html"
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
    private readonly environmentService: EnvironmentService,
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

          // 提取正文并清理，同时收集附件元数据 + Confluence 权威标题
          const {
            cleanedHtml,
            pageAttachments,
            title: confluenceTitle,
          } = this.extractAndClean(rawHtml);

          // 转换代码块
          const htmlWithCode = this.transformCodeBlocks(cleanedHtml);

          // 转换 mermaid 图表宏（产出带 code 子节点的 pre，不与 noformat 冲突）
          const htmlWithMermaid = this.transformMermaidMacros(htmlWithCode);

          // 转换 noformat 预格式化宏（必须在 transformCodeBlocks 之后）
          const htmlWithNoformat = this.transformNoformatMacros(htmlWithMermaid);

          // 转换 expand 折叠宏
          const htmlWithExpand = this.transformExpandMacros(htmlWithNoformat);

          // 转换 info/tip/note/warning 告警框宏
          const htmlWithCallout = this.transformInfoMacros(htmlWithExpand);

          // 转换 status 状态标签宏
          const htmlWithStatus = this.transformStatusMacros(htmlWithCallout);

          // 调用现有附件处理（上传图片/附件，替换路径）
          const htmlWithAttachments =
            await this.importAttachmentService.processAttachments({
              html: htmlWithStatus,
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
            spaceKey: confluenceSpaceKey,
            targetUrl: buildPageUrl(appUrl, space?.slug, page.slugId),
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
        this.logger.debug(`Resolved content dir: ${subDirs[0].name}/`);
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
      $('body > div ul')
        .first()
        .each((_, ul) => processUl(ul, null));
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
        p.position =
          i === 0 ? firstPos : generateJitteredKeyBetween(prev, null);
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

    // 移除脚本/样式:markdown 等宏在导出 HTML 里会注入 <script>(如 hljs
    // 高亮)和 <style>,若原样透传进编辑器会造成显示异常/解析混乱。宏正文
    // 本身已被 Confluence 渲染成正常 HTML(h1/p 等),删掉这些标签即可。
    $('script').remove();
    $('style').remove();

    // 拆除标题里的自引用锚点:Confluence 给每个标题自动包一个指向自身的
    // 锚点 <h1 id="x"><a href="#x">标题</a></h1>(用于"复制链接到此标题")。
    // 透传进编辑器后 <a> 会被当成真实链接,标题带上链接图标。这里把标题内
    // 以 # 开头(页内锚点)的 <a> 替换成其纯文本,保留标题文字、去掉链接。
    $('h1, h2, h3, h4, h5, h6').find('a[href^="#"]').each((_, el) => {
      const $a = $(el);
      $a.replaceWith($a.text());
    });

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

  // ─── Step 3c1: mermaid 图表宏转换 ────────────────────────────────────────
  //
  // Confluence mermaid 宏(第三方插件)导出成 HTML 后,图表源码以纯文本形式
  // 保留在一个 div 里:
  //   <div class="mermaid" style="...">
  //   %%{init: ...}%%
  //   flowchart TD ...
  //   </div>
  // 若原样透传,div 被编辑器 schema 丢弃、里面的源码变成一大段普通文本(乱码观感)。
  // Akasha 的 mermaid 是 codeBlock 的一种 language(language-mermaid),前端
  // NodeView 会把源码渲染成 SVG 图。因此转成:
  //   <pre><code class="language-mermaid">图表源码</code></pre>
  private transformMermaidMacros(html: string): string {
    if (!html) return html;

    const $ = cheerioLoad(html);

    $('div.mermaid').each((_, el) => {
      const $div = $(el);
      // 源码是 div 的纯文本内容;去掉首尾空白(导出时常有前导换行)
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

  // ─── Step 3c2: noformat 预格式化宏转换 ───────────────────────────────────
  //
  // Confluence noformat 宏导出成 HTML 有两种形式:
  //   有面板(默认):
  //     <div class="preformatted panel"><div class="preformattedContent panelContent">
  //       <pre>预格式化文本</pre>
  //     </div></div>
  //   无面板(nopanel=true):
  //     <pre>预格式化文本</pre>
  // noformat 语义是"保留空白+等宽字体、但不做语法高亮的预格式化文本"
  // (内容未必是代码,可能是日志/ASCII 表格/纯文本)。编辑器没有独立的
  // preformatted 节点,唯一能保留多行+空白+等宽的块是 codeBlock。但 codeBlock
  // 在 language 为空/未注册时会走 highlightAuto 自动探测语言并着色 —— 这会把
  // 纯文本误着色,与 noformat 语义相悖。因此显式标注 language-plaintext:
  // plaintext 已在 lowlight(common 集)注册且高亮规则为"零着色",高亮插件会
  // 走"已注册语言"分支而非 highlightAuto,得到纯等宽、无语法色的预格式化文本。
  // 两种形式统一转成:
  //   <pre><code class="language-plaintext">预格式化文本</code></pre>
  //
  // 重要:必须在 transformCodeBlocks 之后调用。code 宏产出的 <pre> 已被
  // transformCodeBlocks 转成 <pre><code class="language-x">(含 code 子节点),
  // 这里用"无 code 子节点"作判别跳过它们,避免误伤代码块 / 覆盖其语言。
  private transformNoformatMacros(html: string): string {
    if (!html) return html;

    const $ = cheerioLoad(html);

    const toCodeBlock = (text: string) => {
      const $newPre = $('<pre>');
      const $code = $('<code>').addClass('language-plaintext').text(text);
      $newPre.append($code);
      return $newPre;
    };

    // 形式一(有面板):替换整个 preformatted panel 容器
    $('div.preformatted').each((_, el) => {
      const $panel = $(el);
      const $pre = $panel.find('pre').first();
      if (!$pre.length) return;
      $panel.replaceWith(toCodeBlock($pre.text()));
    });

    // 形式二(无面板)+ 兜底:裸 <pre>,无 <code> 子节点者包成标准代码块。
    // (上一步新建的 <pre><code> 与 code 宏产物都含 code 子节点,自动跳过)
    $('pre').each((_, el) => {
      const $pre = $(el);
      if ($pre.find('code').length) return;
      $pre.replaceWith(toCodeBlock($pre.text()));
    });

    return $.root().html() ?? html;
  }

  // ─── Step 3d: expand 折叠宏转换 ──────────────────────────────────────────
  //
  // Confluence expand 宏导出成 HTML 后是:
  //   <div class="expand-container">
  //     <div class="expand-control"><span class="expand-control-text">标题</span></div>
  //     <div class="expand-content ...">正文...</div>
  //   </div>
  // 目标编辑器折叠块(details 节点,来自 @docmost/editor-ext)内容模型严格要求
  // 恰好是 <summary> + <div data-type="detailsContent">,顺序固定:
  //   <details open>
  //     <summary>标题</summary>
  //     <div data-type="detailsContent">正文...</div>
  //   </details>
  private transformExpandMacros(html: string): string {
    if (!html) return html;

    const $ = cheerioLoad(html);

    // 逆序处理,保证嵌套 expand 由内向外转换:内层先变成 details,外层再把
    // 已转好的节点整体搬入 detailsContent(移动实际节点而非序列化字符串,
    // 避免内层已转换结果丢失)。
    const containers = $('div.expand-container').toArray().reverse();

    for (const el of containers) {
      const $container = $(el);

      // 标题:expand-control-text,取不到时用兜底文案(summary 不可为空)
      const titleText =
        $container.find('.expand-control-text').first().text().trim() ||
        'Details';

      // 正文:expand-content(本容器对应的第一个;嵌套的内层此时已被替换掉)
      const $content = $container.find('div.expand-content').first();

      const $details = $('<details>').attr('open', '');
      const $summary = $('<summary>').text(titleText);
      const $detailsContent = $('<div>').attr('data-type', 'detailsContent');

      // 移动实际子节点(含已转换的内层 details),而非用 .html() 序列化重建
      if ($content.length) {
        $detailsContent.append($content.contents());
      }

      $details.append($summary).append($detailsContent);
      $container.replaceWith($details);
    }

    return $.root().html() ?? html;
  }

  // ─── Step 3e: info/tip/note/warning 告警框宏转换 ─────────────────────────
  //
  // Confluence 的 4 个告警框宏导出成 HTML 后是带 class 的 div:
  //   <div class="confluence-information-macro confluence-information-macro-tip">
  //     <span class="aui-icon ..."></span>
  //     <p class="title">可选标题</p>            (title 参数,不一定有)
  //     <div class="confluence-information-macro-body"><p>正文</p></div>
  //   </div>
  // 目标 callout 节点(@docmost/editor-ext)只认 data-type/data-callout-type 属性,
  // 不认 Confluence class,内容模型是纯 block+、无 title 字段。因此:
  //   1. class 关键字 → data-callout-type 映射(见下表)
  //   2. title 参数无处安放 → 转成 callout 内容里的加粗首行 <p><strong>title</strong></p>
  // 产出:
  //   <div data-type="callout" data-callout-type="success">
  //     <p><strong>可选标题</strong></p>
  //     <p>正文</p>
  //   </div>
  private transformInfoMacros(html: string): string {
    if (!html) return html;

    const $ = cheerioLoad(html);

    // Confluence class 关键字 → callout type
    // tip(绿)→success, info(蓝)→info, note(黄)→warning, warning(红)→danger
    const classToType = (className: string): string => {
      if (/confluence-information-macro-tip\b/.test(className)) return 'success';
      if (/confluence-information-macro-note\b/.test(className))
        return 'warning';
      if (/confluence-information-macro-warning\b/.test(className))
        return 'danger';
      // -information 及无后缀的 info 宏都归 info(蓝)
      return 'info';
    };

    // 逆序处理,保证嵌套告警框由内向外转换(移动实际节点,避免内层结果丢失)
    const macros = $('div.confluence-information-macro').toArray().reverse();

    for (const el of macros) {
      const $macro = $(el);
      const calloutType = classToType($macro.attr('class') ?? '');

      const $callout = $('<div>')
        .attr('data-type', 'callout')
        .attr('data-callout-type', calloutType);

      // 标题:title 参数导出成 .title(不同版本可能是 p.title / b.title 等)。
      // 取第一个非空,转成加粗首行塞进 callout(callout 无 title 字段)。
      const titleText = $macro.find('.title').first().text().trim();
      if (titleText) {
        const $titleP = $('<p>');
        $titleP.append($('<strong>').text(titleText));
        $callout.append($titleP);
      }

      // 正文:优先 macro-body;取不到时兜底用整个 macro 内容(排除 icon/title)
      const $body = $macro
        .find('div.confluence-information-macro-body')
        .first();
      if ($body.length) {
        $callout.append($body.contents());
      } else {
        // 无 body 包裹:移除图标和 title 后,把剩余内容搬进去
        $macro.find('span.aui-icon, .title').remove();
        $callout.append($macro.contents());
      }

      $macro.replaceWith($callout);
    }

    return $.root().html() ?? html;
  }

  // ─── Step 3f: status 状态标签宏转换 ──────────────────────────────────────
  //
  // Confluence status 宏(使用量最高)导出成 HTML 后是 AUI lozenge 内联标签:
  //   <span class="status-macro aui-lozenge aui-lozenge-success ...">已完成</span>
  // 目标 status 节点(@docmost/editor-ext)是 inline atom,只认 span[data-type="status"],
  // 文本放 textContent、颜色放 data-color(gray/blue/green/yellow/red/purple)。
  // 产出:
  //   <span data-type="status" data-color="green">已完成</span>
  //
  // 颜色映射:AUI lozenge 用语义 class(success/error/current/moved/complete),
  // 非颜色词。按 AUI 色彩语义映射:
  //   success→green, error→red, current→blue, moved→yellow, complete→gray,
  //   无类型修饰(default lozenge)→gray。
  // 注:Confluence 各版本 Yellow/Blue 落到 current 还是 moved 存在差异,
  //     若真实导出与预期不符,调整下方映射表即可。
  private transformStatusMacros(html: string): string {
    if (!html) return html;

    const $ = cheerioLoad(html);

    const auiClassToColor = (className: string): string => {
      if (/\baui-lozenge-success\b/.test(className)) return 'green';
      if (/\baui-lozenge-error\b/.test(className)) return 'red';
      if (/\baui-lozenge-current\b/.test(className)) return 'blue';
      if (/\baui-lozenge-moved\b/.test(className)) return 'yellow';
      if (/\baui-lozenge-complete\b/.test(className)) return 'gray';
      // 无类型修饰(subtle 是变体不是类型)= default grey
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

  // ─── 降级：无 index.html 时平铺导入 ─────────────────────────────────────

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

        // fallback 路径无层级映射，移除内部链接 href 避免被误转成 embed
        const $ = cheerioLoad(htmlWithStatus);
        $('a[href]').each((_, el) => {
          const href = $(el).attr('href') ?? '';
          if (/^\d+\.html$/.test(href)) $(el).removeAttr('href');
        });
        const htmlWithLinks = $.root().html() ?? htmlWithStatus;

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
            spaceKey: confluenceSpaceKey,
            targetUrl: buildPageUrl(appUrl, space?.slug, insertablePage.slugId),
          });
        } else {
          this.logger.warn(
            `Cannot map non-numeric Confluence HTML file: ${filePath}`,
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
