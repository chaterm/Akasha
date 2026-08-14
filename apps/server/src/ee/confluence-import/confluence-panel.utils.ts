import { load } from 'cheerio';

function readPixelWidth(value: string | undefined): string {
  const match = String(value || '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)px$/i);
  return match?.[1] ?? '';
}

/** Convert Confluence's exported Panel HTML into the Akasha Panel node HTML. */
export function transformConfluencePanels(html: string): string {
  if (!html) return html;

  const $ = load(html, null, false);

  $('div.panel').each((_, panelEl) => {
    const $panel = $(panelEl);
    if ($panel.hasClass('code')) return;

    const $content = $panel.children('.panelContent').first();
    if (!$content.length) return;

    const $header = $panel.children('.panelHeader').first();
    const title = $header.text().trim().replace(/\s+/g, ' ');
    const borderWidth = readPixelWidth($panel.css('border-width'));

    const $akashaPanel = $('<div>').attr('data-type', 'panel');
    const attributes = {
      'data-panel-title': title,
      'data-panel-border-style': $panel.css('border-style') || '',
      'data-panel-border-color': $panel.css('border-color') || '',
      'data-panel-border-width': borderWidth,
      'data-panel-bg-color': $panel.css('background-color') || '',
      'data-panel-title-bg-color': $header.css('background-color') || '',
      'data-panel-title-color': $header.css('color') || '',
    };

    for (const [name, value] of Object.entries(attributes)) {
      if (value) $akashaPanel.attr(name, value);
    }

    $akashaPanel.append($content.contents());
    $panel.replaceWith($akashaPanel);
  });

  return $.root().html() ?? html;
}
