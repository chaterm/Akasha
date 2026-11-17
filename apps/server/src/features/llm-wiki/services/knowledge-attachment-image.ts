import { Attachment } from '@akasha/db/types/entity.types';

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
