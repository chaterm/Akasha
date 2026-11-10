import { Attachment } from '@akasha/db/types/entity.types';

/**
 * Single source of truth for "is this attachment an image?" shared by the
 * source serializer (which decides what becomes a top-level attachment marker)
 * and the query-time attachment resolver (which filters images out of the
 * response). Keeping one definition prevents the two sides from drifting so an
 * image can never slip into the top-level `attachments[]` on one path while
 * being rejected on the other.
 *
 * Detection is intentionally broader than the exporter's narrow raster
 * allow-list (which excludes SVG for vision enrichment): any `image/*` MIME type
 * counts as an image, and a missing or generic MIME type falls back to a common
 * image extension check. Anything not confidently an image is treated as a
 * normal attachment.
 *
 * IMAGE_EXTENSIONS must stay a superset of the exporter's safe raster extension
 * set (jpg/jpe/jpeg/png/apng/gif/webp/avif/tif/tiff/bmp/dib) so no format the
 * exporter recognizes as an image can leak through here as a plain file.
 */
export const IMAGE_EXTENSIONS = new Set([
  'png',
  'apng',
  'jpg',
  'jpeg',
  'jpe',
  'gif',
  'webp',
  'bmp',
  'dib',
  'svg',
  'avif',
  'heic',
  'tif',
  'tiff',
  'ico',
]);

export function isImageAttachment(attachment: Attachment): boolean {
  const mimeType = attachment.mimeType?.trim().toLowerCase() ?? '';
  if (mimeType.startsWith('image/')) return true;
  if (mimeType && mimeType !== 'application/octet-stream') return false;

  const extension = attachment.fileExt?.trim().toLowerCase().replace(/^\./, '');
  return IMAGE_EXTENSIONS.has(extension ?? '');
}
