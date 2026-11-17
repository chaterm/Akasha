import { getEmbedUrlAndProvider } from '@docmost/editor-ext';
import { Logger } from '@nestjs/common';
import * as path from 'path';
import { v7 } from 'uuid';
import { InsertableBacklink } from '@akasha/db/types/entity.types';

const logger = new Logger('ImportFormatter');
import { Cheerio, CheerioAPI, load } from 'cheerio';
import slugify from '@sindresorhus/slugify';
import { normalizeTableColumnWidths } from './table-utils';

function isUnicodeCharacter(text: string): boolean {
  return text.length > 0 && text.codePointAt(0)! > 127;
}

export async function formatImportHtml(opts: {
  html: string;
  currentFilePath: string;
  filePathToPageMetaMap: Map<
    string,
    { id: string; title: string; slugId: string }
  >;
  creatorId: string;
  sourcePageId: string;
  workspaceId: string;
  pageDir?: string;
  attachmentCandidates?: string[];
  spaceSlug?: string;
}): Promise<{
  html: string;
  backlinks: InsertableBacklink[];
  pageIcon?: string;
}> {
  const {
    html,
    currentFilePath,
    filePathToPageMetaMap,
    creatorId,
    sourcePageId,
    workspaceId,
  } = opts;
  const $: CheerioAPI = load(html);
  const $root: Cheerio<any> = $.root();

  let pageIcon: string | null = null;
  const headerIconSpan = $root.find('header .page-header-icon .icon');

  if (headerIconSpan.length > 0) {
    const iconText = headerIconSpan.text().trim();
    if (iconText && isUnicodeCharacter(iconText)) {
      pageIcon = iconText;
    }
  }

  normalizeImportHtml($, $root);

  const backlinks = await rewriteInternalLinksToMentionHtml(
    $,
    $root,
    currentFilePath,
    filePathToPageMetaMap,
    creatorId,
    sourcePageId,
    workspaceId,
    opts.spaceSlug,
  );

  return {
    html: $root.html() || '',
    backlinks,
    pageIcon: pageIcon || undefined,
  };
}

export function normalizeImportHtml($: CheerioAPI, $root: Cheerio<any>): void {
  notionFormatter($, $root);
  xwikiFormatter($, $root);
  defaultHtmlFormatter($, $root);
}

export function xwikiFormatter($: CheerioAPI, $root: Cheerio<any>) {
  const $content = $root.find('#xwikicontent');
  if ($content.length) {
    $root.children().remove();
    $root.append($content.contents());
  }
}

export function defaultHtmlFormatter($: CheerioAPI, $root: Cheerio<any>) {
  normalizeTableColumnWidths($, $root);

  $root.find('a[href]').each((_, el) => {
    const $el = $(el);
    const url = $el.attr('href')!;
    const { provider } = getEmbedUrlAndProvider(url);
    if (provider === 'iframe') return;

    const embed = `<div data-type=\"embed\" data-src=\"${url}\" data-provider=\"${provider}\" data-align=\"center\" data-width=\"640\" data-height=\"480\"></div>`;
    $el.replaceWith(embed);
  });

  $root.find('iframe[src]').each((_, el) => {
    const $el = $(el);
    const url = $el.attr('src')!;
    const { provider } = getEmbedUrlAndProvider(url);

    const embed = `<div data-type=\"embed\" data-src=\"${url}\" data-provider=\"${provider}\" data-align=\"center\" data-width=\"640\" data-height=\"480\"></div>`;
    $el.replaceWith(embed);
  });
}

const COLUMN_LAYOUTS = [
  '',
  '',
  'two_equal',
  'three_equal',
  'four_equal',
  'five_equal',
] as const;

export function notionFormatter($: CheerioAPI, $root: Cheerio<any>) {
  $root.find('.page-header-icon').remove();
  $root.find('.page-cover-image').remove();

  $root.find('p.page-description').each((_, el) => {
    if (!$(el).text().trim()) $(el).remove();
  });

  $root.find('div.column-list').each((_, el) => {
    const $list = $(el);
    const $cols = $list.find('div.column');

    if ($cols.length <= 1) {
      $list.replaceWith($cols.html() || '');
      return;
    }

    const layout = COLUMN_LAYOUTS[$cols.length] ?? 'two_equal';
    let cells = '';
    $cols.each((_, col) => {
      const $col = $(col);
      $col.children('div[style*="display:contents"]').each((_, wrapper) => {
        $(wrapper).replaceWith($(wrapper).html() || '');
      });
      cells += `<div data-type="column">${$col.html()}</div>`;
    });

    $list.replaceWith(
      `<div data-type="columns" data-layout="${layout}">${cells}</div>`,
    );
  });

  $root.find('figure.equation').each((_: any, fig: any) => {
    const $fig = $(fig);
    const tex = $fig
      .find('annotation[encoding="application/x-tex"]')
      .text()
      .trim();
    const $math = $('<div>')
      .attr('data-type', 'mathBlock')
      .attr('data-katex', 'true')
      .text(tex);
    $fig.replaceWith($math);
  });

  $root.find('span.notion-text-equation-token').each((_, tok) => {
    const $tok = $(tok);
    const $prev = $tok.prev('style');
    if ($prev.length) $prev.remove();
    const tex = $tok
      .find('annotation[encoding="application/x-tex"]')
      .text()
      .trim();
    const $inline = $('<span>')
      .attr('data-type', 'mathInline')
      .attr('data-katex', 'true')
      .text(tex);
    $tok.replaceWith($inline);
  });

  $root
    .find('figure.callout')
    .get()
    .reverse()
    .forEach((fig) => {
      const $fig = $(fig);
      const $content = $fig.find('div').eq(1);
      if (!$content.length) return;
      const $wrapper = $('<div>')
        .attr('data-type', 'callout')
        .attr('data-callout-type', 'info');
      // @ts-ignore
      $content.children().each((_, child) => $wrapper.append(child));
      $fig.replaceWith($wrapper);
    });

  $root.find('ul.to-do-list').each((_, list) => {
    const $old = $(list);
    const $new = $('<ul>').attr('data-type', 'taskList');
    $old.find('li').each((_, li) => {
      const $li = $(li);
      const isChecked = $li.find('.checkbox.checkbox-on').length > 0;
      const text =
        $li
          .find('span.to-do-children-unchecked, span.to-do-children-checked')
          .first()
          .text()
          .trim() || '';
      const $taskItem = $('<li>')
        .attr('data-type', 'taskItem')
        .attr('data-checked', String(isChecked));
      const $label = $('<label>');
      const $input = $('<input>').attr('type', 'checkbox');
      if (isChecked) $input.attr('checked', '');
      $label.append($input, $('<span>'));
      const $container = $('<div>').append($('<p>').text(text));
      $taskItem.append($label, $container);
      $new.append($taskItem);
    });
    $old.replaceWith($new);
  });

  $root
    .find('ul.toggle details')
    .get()
    .reverse()
    .forEach((det) => {
      const $det = $(det);
      const $li = $det.closest('li');
      if ($li.length) {
        $li.before($det);
        if (!$li.children().length) $li.remove();
      }
      const $ul = $det.closest('ul.toggle');
      if ($ul.length) {
        $ul.before($det);
        if (!$ul.children().length) $ul.remove();
      }
    });

  $root
    .find('figure')
    .filter((_, fig) => $(fig).find('a.bookmark.source').length > 0)
    .get()
    .reverse()
    .forEach((fig) => {
      const $fig = $(fig);
      const $link = $fig.find('a.bookmark.source').first();
      if (!$link.length) return;

      const href = $link.attr('href')!;
      const title = $link.find('.bookmark-title').text().trim() || href;

      const $newAnchor = $('<a>')
        .addClass('bookmark source')
        .attr('href', href)
        .append($('<div>').addClass('bookmark-info').text(title));

      $fig.replaceWith($newAnchor);
    });

  $root.find('span.user img.user-icon').remove();

  $root.find('nav.table_of_contents').remove();
}

export function unwrapFromParagraph($: CheerioAPI, $node: Cheerio<any>) {
  const processedWrappers = new Set<any>();

  let $wrapper = $node.closest('p, a');
  while ($wrapper.length) {
    const wrapperElement = $wrapper.get(0);

    if (processedWrappers.has(wrapperElement)) {
      break;
    }

    processedWrappers.add(wrapperElement);

    const hasOnlyTargetNode =
      $wrapper.contents().filter((_, el) => {
        const $el = $(el);
        if (el.nodeType === 3 && !$el.text().trim()) {
          return false;
        }
        return !$el.is($node) && !$node.is($el);
      }).length === 0;

    if (hasOnlyTargetNode) {
      $wrapper.replaceWith($node);
    } else {
      $wrapper.before($node);
    }

    $wrapper = $node.closest('p, a');
  }
}

export async function rewriteInternalLinksToMentionHtml(
  $: CheerioAPI,
  $root: Cheerio<any>,
  currentFilePath: string,
  filePathToPageMetaMap: Map<
    string,
    { id: string; title: string; slugId: string }
  >,
  creatorId: string,
  sourcePageId: string,
  workspaceId: string,
  spaceSlug?: string,
): Promise<InsertableBacklink[]> {
  const normalize = (p: string) => p.replace(/\\/g, '/');
  const backlinks: InsertableBacklink[] = [];

  $root.find('a[href]').each((_, el) => {
    const $a = $(el);
    const raw = $a.attr('href')!;
    if (raw.startsWith('http') || raw.startsWith('/api/')) return;
    let decodedRaw = raw;
    try {
      decodedRaw = decodeURIComponent(raw);
    } catch (err) {
      logger.warn(
        { filePath: currentFilePath, raw },
        'URI malformed in page, falling back to raw path',
      );
    }

    const resolved = normalize(
      path.join(path.dirname(currentFilePath), decodedRaw),
    );
    const meta = filePathToPageMetaMap.get(resolved);
    if (!meta) return;

    const linkText = $a.text().trim();
    const titleMatch =
      linkText === meta.title || linkText === meta.title?.trim();

    if (titleMatch) {
      const mentionId = v7();
      const $mention = $('<span>')
        .attr({
          'data-type': 'mention',
          'data-id': mentionId,
          'data-entity-type': 'page',
          'data-entity-id': meta.id,
          'data-label': meta.title,
          'data-slug-id': meta.slugId,
          'data-creator-id': creatorId,
        })
        .text(meta.title);
      $a.replaceWith($mention);
    } else {
      const titleSlug = slugify(meta.title?.substring(0, 70) || 'untitled');
      const pageSlug = `${titleSlug}-${meta.slugId}`;
      const internalHref = spaceSlug
        ? `/s/${spaceSlug}/p/${pageSlug}`
        : `/p/${pageSlug}`;

      $a.attr('href', internalHref);
      $a.attr('data-internal', 'true');
    }

    backlinks.push({ sourcePageId, targetPageId: meta.id, workspaceId });
  });

  return backlinks;
}
