import type { CheerioAPI } from 'cheerio';
import type { AttachmentInfo } from '../../integrations/import/services/import-attachment.service';
import { encodeFilePath } from '../../integrations/import/utils/import.utils';

export function transformConfluenceFileLists(
  $: CheerioAPI,
  attachments: AttachmentInfo[],
): void {
  const attachmentsById = new Map<string, AttachmentInfo>();
  const attachmentsByName = new Map<string, AttachmentInfo[]>();

  for (const attachment of attachments) {
    const match = attachment.href.match(/^attachments\/(\d+)\/([^/]+)$/);
    if (!match) continue;
    const [, pageId, storedName] = match;
    const id = storedName.match(/^(\d+)(?:\.|$)/)?.[1];
    if (id) attachmentsById.set(`${pageId}/${id}`, attachment);
    const nameKey = `${pageId}/${attachment.fileName}`;
    const versions = attachmentsByName.get(nameKey) ?? [];
    versions.push(attachment);
    attachmentsByName.set(nameKey, versions);
  }

  $('div.plugin_attachments_container').each((_, container) => {
    const $container = $(container);
    const $list = $('<div>').attr('data-type', 'fileList');
    const macroPageId = $container.find('input[name="pageId"]').first().val();

    $container.find('table.attachments tr.attachment-row').each((_, row) => {
      const $row = $(row);
      const $link = $row.find('a.filename').first();
      const name = $link.attr('data-filename') || $link.text().trim();
      if (!name) return;

      const href = ($link.attr('href') ?? '').split(/[?#]/, 1)[0];
      const downloadPageId = href.match(
        /\/download\/attachments\/(\d+)\//,
      )?.[1];
      const pageId =
        $link.attr('data-linked-resource-container-id') ||
        downloadPageId ||
        macroPageId;
      const attachmentId =
        $row.attr('data-attachment-id') ||
        $row.attr('id')?.match(/^attachment-(\d+)$/)?.[1];
      const attachment = attachmentsById.get(`${pageId}/${attachmentId}`);

      // The export footer also lists historical versions of files in the macro.
      for (const version of attachmentsByName.get(`${pageId}/${name}`) ?? []) {
        version.includeInBody = false;
      }
      if (attachment) attachment.includeInBody = false;

      const $modified = $row.find('.modified-column').first();
      const $file = $('<div>').attr({
        'data-type': 'attachment',
        'data-attachment-name': name,
        'data-attachment-mime':
          $link.attr('data-type') || attachment?.mimeType || '',
        'data-attachment-modified-at': $modified
          .children('span')
          .first()
          .text()
          .trim(),
        'data-attachment-modified-by': $modified
          .find('a')
          .first()
          .text()
          .trim(),
        'data-attachment-comment': $row
          .find('.attachment-comment')
          .first()
          .text()
          .trim(),
      });

      // Use the exact attachment ID when the archive contains versions with the same name.
      if (attachment) {
        $file.attr('data-attachment-url', encodeFilePath(attachment.href));
      } else if (downloadPageId === pageId && downloadPageId) {
        $file.attr(
          'data-attachment-url',
          `attachments/${pageId}/${encodeURIComponent(name)}`,
        );
      } else if (href.startsWith('attachments/')) {
        $file.attr('data-attachment-url', href);
      }
      $list.append($file);
    });

    $container.replaceWith($list);
  });
}
