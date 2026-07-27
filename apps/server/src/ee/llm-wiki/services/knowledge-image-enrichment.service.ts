import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import sharp = require('sharp');
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import {
  KnowledgeImageExtractionClaim,
  KnowledgeImageExtractionRepo,
} from '@akasha/db/repos/llm-wiki/knowledge-image-extraction.repo';
import { StorageService } from '../../../integrations/storage/storage.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import {
  KnowledgeSourceImage,
  KnowledgeSourceSnapshot,
} from '../types/source-snapshot.types';
import {
  DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
  KNOWLEDGE_IMAGE_UNDERSTANDING_PROVIDER,
} from '../llm-wiki.constants';
import {
  KnowledgeImageUnderstandingError,
  KnowledgeImageUnderstandingProvider,
} from './knowledge-image-understanding-provider.service';

const MAX_IMAGES_PER_PAGE = 12;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_NORMALIZED_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_VISION_DIMENSION = 4_096;
const MAX_OCR_CHARS_PER_IMAGE = 12_000;
const MAX_CAPTION_CHARS_PER_IMAGE = 2_000;
const MAX_ENRICHMENT_CHARS_PER_PAGE = 40_000;
const IMAGE_NORMALIZATION_VERSION = 'akasha-raster-normalization-v1';
const CLAIM_LEASE_GRACE_MS = 30_000;
const MAX_RETRY_BACKOFF_MS = 30 * 60_000;

type SupportedRasterMime =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'image/avif'
  | 'image/tiff'
  | 'image/bmp';

export type KnowledgeImageEnrichmentWarning = {
  attachmentId: string;
  code: string;
  message: string;
};

export type KnowledgeImageEnrichmentResult = {
  source: KnowledgeSourceSnapshot;
  imageCount: number;
  succeededCount: number;
  failedCount: number;
  cacheHitCount: number;
  warnings: KnowledgeImageEnrichmentWarning[];
};

type ExtractedImageText = {
  attachmentId: string;
  fileName: string;
  altText?: string;
  ocrText: string;
  caption: string;
};

type NormalizedImage = {
  bytes: Buffer;
  mimeType: 'image/jpeg' | 'image/png';
};

class ImageNormalizationError extends Error {
  constructor(readonly code: 'unsupported_image' | 'invalid_image') {
    super(
      code === 'unsupported_image'
        ? 'The attachment is not a supported raster image.'
        : 'The attachment is not a valid or safely decodable image.',
    );
    this.name = 'ImageNormalizationError';
  }
}

@Injectable()
export class KnowledgeImageEnrichmentService {
  private readonly logger = new Logger(KnowledgeImageEnrichmentService.name);

  constructor(
    private readonly attachmentRepo: AttachmentRepo,
    private readonly extractionRepo: KnowledgeImageExtractionRepo,
    private readonly storageService: StorageService,
    private readonly environmentService: EnvironmentService,
    @Inject(KNOWLEDGE_IMAGE_UNDERSTANDING_PROVIDER)
    private readonly imageProvider: KnowledgeImageUnderstandingProvider,
  ) {}

  async enrichSource(
    source: KnowledgeSourceSnapshot,
  ): Promise<KnowledgeImageEnrichmentResult> {
    const sourceImages = (source.images ?? []).slice(0, MAX_IMAGES_PER_PAGE);
    const warnings: KnowledgeImageEnrichmentWarning[] = [];
    if ((source.images?.length ?? 0) > MAX_IMAGES_PER_PAGE) {
      warnings.push({
        attachmentId: '',
        code: 'image_limit_exceeded',
        message: `Only the first ${MAX_IMAGES_PER_PAGE} page images were processed.`,
      });
    }
    if (sourceImages.length === 0) {
      return emptyResult(source, warnings);
    }
    if (!this.imageProvider.isConfigured()) {
      return {
        ...emptyResult(source, warnings),
        imageCount: sourceImages.length,
        failedCount: sourceImages.length,
        warnings: [
          ...warnings,
          ...sourceImages.map((image) => ({
            attachmentId: image.attachmentId,
            code: 'vision_model_not_configured',
            message: 'Knowledge image understanding model is not configured.',
          })),
        ],
      };
    }

    const attachments = await this.attachmentRepo.findByIds(
      sourceImages.map((image) => image.attachmentId),
    );
    const attachmentById = new Map(
      attachments.map((attachment) => [attachment.id, attachment]),
    );
    const extracted: ExtractedImageText[] = [];
    let cacheHitCount = 0;

    // Keep the first release sequential inside the page worker. Atomic cache
    // leases prevent duplicate VLM calls across multiple server instances.
    for (const image of sourceImages) {
      const attachment = attachmentById.get(image.attachmentId);
      if (
        !attachment ||
        attachment.workspaceId !== source.workspaceId ||
        attachment.spaceId !== source.spaceId ||
        attachment.pageId !== source.sourcePageId ||
        attachment.type !== AttachmentType.File ||
        attachment.deletedAt ||
        attachment.updatedAt.toISOString() !== image.attachmentVersion
      ) {
        warnings.push(warning(image.attachmentId, 'image_changed'));
        continue;
      }
      if (
        attachment.fileSize !== null &&
        Number(attachment.fileSize) > MAX_IMAGE_BYTES
      ) {
        warnings.push(warning(image.attachmentId, 'image_too_large'));
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = await this.storageService.read(attachment.filePath);
      } catch {
        warnings.push(warning(image.attachmentId, 'image_unreadable'));
        continue;
      }
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
        warnings.push(
          warning(
            image.attachmentId,
            bytes.length === 0 ? 'image_empty' : 'image_too_large',
          ),
        );
        continue;
      }

      const detectedMime = sniffRasterMime(bytes);
      if (!detectedMime) {
        warnings.push(warning(image.attachmentId, 'unsupported_image'));
        continue;
      }

      const contentHash = hash(bytes);
      const cacheKey = {
        workspaceId: source.workspaceId,
        attachmentId: image.attachmentId,
        cacheFingerprint: hash(
          Buffer.from(
            JSON.stringify([
              IMAGE_NORMALIZATION_VERSION,
              contentHash,
              detectedMime,
              normalizeCacheMetadata(image.fileName),
              normalizeCacheMetadata(image.altText ?? ''),
              this.imageProvider.getCacheIdentity(),
              DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
            ]),
          ),
        ),
        contentHash,
        model: this.environmentService.getAiVisionModel().trim(),
        promptVersion: DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
      };

      let claim: KnowledgeImageExtractionClaim;
      try {
        claim = await this.extractionRepo.claim(
          cacheKey,
          this.environmentService.getKnowledgeImageTimeoutMs() +
            CLAIM_LEASE_GRACE_MS,
        );
      } catch {
        warnings.push(warning(image.attachmentId, 'image_cache_unavailable'));
        continue;
      }

      if (claim.state === 'ready') {
        cacheHitCount += 1;
        appendCachedExtraction(extracted, image, claim.extraction);
        if (
          !claim.extraction.ocrText?.trim() &&
          !claim.extraction.caption?.trim()
        ) {
          warnings.push(warning(image.attachmentId, 'image_no_content'));
        }
        continue;
      }
      if (claim.state === 'busy') {
        warnings.push(
          warning(image.attachmentId, 'image_processing_in_progress'),
        );
        continue;
      }
      if (claim.state === 'failed') {
        warnings.push(
          warning(
            image.attachmentId,
            claim.extraction.retryable
              ? 'image_retry_backoff'
              : claim.extraction.errorCode || 'image_processing_failed',
          ),
        );
        continue;
      }

      try {
        const normalized = await normalizeForVision(bytes, detectedMime);
        const result = await this.imageProvider.describe({
          bytes: normalized.bytes,
          mimeType: normalized.mimeType,
          fileName: image.fileName,
          altText: image.altText,
        });
        const ocrText = normalizeExtractedText(result.ocrText).slice(
          0,
          MAX_OCR_CHARS_PER_IMAGE,
        );
        const caption = normalizeExtractedText(result.caption).slice(
          0,
          MAX_CAPTION_CHARS_PER_IMAGE,
        );
        const published = await this.extractionRepo.completeSuccess({
          extractionId: claim.extraction.id,
          leaseToken: claim.leaseToken,
          mimeType: normalized.mimeType,
          fileName: image.fileName,
          ocrText,
          caption,
        });
        if (!published) {
          warnings.push(warning(image.attachmentId, 'image_result_superseded'));
          continue;
        }
        if (!ocrText && !caption) {
          warnings.push(warning(image.attachmentId, 'image_no_content'));
          continue;
        }
        extracted.push({
          attachmentId: image.attachmentId,
          fileName: image.fileName,
          altText: image.altText,
          ocrText,
          caption,
        });
      } catch (error) {
        const failure = imageFailure(error);
        warnings.push({
          attachmentId: image.attachmentId,
          code: failure.code,
          message: failure.message,
        });
        try {
          await this.extractionRepo.completeFailure({
            extractionId: claim.extraction.id,
            leaseToken: claim.leaseToken,
            errorCode: failure.code,
            errorMessage: failure.message,
            retryable: failure.retryable,
            retryAfter: failure.retryable
              ? new Date(
                  Date.now() + retryBackoffMs(claim.extraction.attemptCount),
                )
              : null,
          });
        } catch {
          this.logger.warn(
            `Failed to persist image extraction failure for attachment ${image.attachmentId}.`,
          );
        }
      }
    }

    const imageText = formatImageKnowledge(extracted);
    return {
      source: imageText
        ? {
            ...source,
            text: source.text.trim()
              ? `${source.text.trimEnd()}\n\n${imageText}`
              : imageText,
          }
        : source,
      imageCount: sourceImages.length,
      succeededCount: extracted.length,
      failedCount: sourceImages.length - extracted.length,
      cacheHitCount,
      warnings,
    };
  }
}

function emptyResult(
  source: KnowledgeSourceSnapshot,
  warnings: KnowledgeImageEnrichmentWarning[],
): KnowledgeImageEnrichmentResult {
  return {
    source,
    imageCount: 0,
    succeededCount: 0,
    failedCount: 0,
    cacheHitCount: 0,
    warnings,
  };
}

function warning(
  attachmentId: string,
  code: string,
): KnowledgeImageEnrichmentWarning {
  const messages: Record<string, string> = {
    image_changed: 'The page image changed before it could be processed.',
    image_too_large: 'The page image exceeds the 8 MB processing limit.',
    image_unreadable: 'The page image could not be read from Akasha storage.',
    image_empty: 'The page image is empty.',
    unsupported_image:
      'The attachment is not a supported GIF, WebP, AVIF, TIFF, BMP, JPEG, or PNG raster image.',
    invalid_image: 'The page image is invalid or exceeds safe pixel limits.',
    image_no_content: 'No searchable text or description was extracted.',
    image_processing_in_progress:
      'The same page image is already being processed.',
    image_retry_backoff:
      'Image understanding is waiting for its bounded retry backoff.',
    image_result_superseded:
      'A newer image extraction worker superseded this result.',
    image_cache_unavailable:
      'The page image extraction cache is temporarily unavailable.',
  };
  return {
    attachmentId,
    code,
    message: messages[code] ?? 'The page image could not be processed.',
  };
}

function imageFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof KnowledgeImageUnderstandingError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof ImageNormalizationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }
  return {
    code: 'image_processing_failed',
    message: 'The page image could not be processed.',
    retryable: true,
  };
}

function appendCachedExtraction(
  extracted: ExtractedImageText[],
  image: KnowledgeSourceImage,
  cached: { ocrText: string | null; caption: string | null },
): void {
  const ocrText = cached.ocrText ?? '';
  const caption = cached.caption ?? '';
  if (!ocrText.trim() && !caption.trim()) return;
  extracted.push({
    attachmentId: image.attachmentId,
    fileName: image.fileName,
    altText: image.altText,
    ocrText,
    caption,
  });
}

async function normalizeForVision(
  bytes: Buffer,
  detectedMime: SupportedRasterMime,
): Promise<NormalizedImage> {
  try {
    const input = sharp(bytes, {
      animated: false,
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS,
    });
    const metadata = await input.metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_IMAGE_DIMENSION ||
      metadata.height > MAX_IMAGE_DIMENSION ||
      metadata.width * metadata.height > MAX_IMAGE_PIXELS
    ) {
      throw new ImageNormalizationError('invalid_image');
    }

    const pipeline = input
      .rotate()
      .resize({
        width: MAX_VISION_DIMENSION,
        height: MAX_VISION_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' });
    const preferJpeg = detectedMime === 'image/jpeg';
    let normalized = preferJpeg
      ? await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer()
      : await pipeline.png({ compressionLevel: 9 }).toBuffer();
    let mimeType: NormalizedImage['mimeType'] = preferJpeg
      ? 'image/jpeg'
      : 'image/png';

    if (normalized.length > MAX_NORMALIZED_IMAGE_BYTES) {
      normalized = await sharp(normalized)
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer();
      mimeType = 'image/jpeg';
    }
    if (
      normalized.length === 0 ||
      normalized.length > MAX_NORMALIZED_IMAGE_BYTES
    ) {
      throw new ImageNormalizationError('invalid_image');
    }
    return { bytes: normalized, mimeType };
  } catch (error) {
    if (error instanceof ImageNormalizationError) throw error;
    throw new ImageNormalizationError('invalid_image');
  }
}

function sniffRasterMime(bytes: Buffer): SupportedRasterMime | undefined {
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  const header = bytes.subarray(0, 12).toString('ascii');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif';
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (header.startsWith('BM')) return 'image/bmp';
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x2a &&
      bytes[3] === 0x00) ||
      (bytes[0] === 0x4d &&
        bytes[1] === 0x4d &&
        bytes[2] === 0x00 &&
        bytes[3] === 0x2a))
  ) {
    return 'image/tiff';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(4, 8).toString('ascii') === 'ftyp' &&
    ['avif', 'avis'].includes(bytes.subarray(8, 12).toString('ascii'))
  ) {
    return 'image/avif';
  }
  return undefined;
}

function retryBackoffMs(attemptCount: number): number {
  const safeAttempt = Math.max(1, Math.min(Number(attemptCount) || 1, 10));
  return Math.min(30_000 * 2 ** (safeAttempt - 1), MAX_RETRY_BACKOFF_MS);
}

function hash(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function normalizeCacheMetadata(value: string): string {
  return value.replace(/\0/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 1_000);
}

function formatImageKnowledge(images: ExtractedImageText[]): string {
  let remaining = MAX_ENRICHMENT_CHARS_PER_PAGE;
  const blocks: string[] = [];
  for (const [index, image] of images.entries()) {
    const caption = normalizeExtractedText(image.caption).slice(
      0,
      Math.min(MAX_CAPTION_CHARS_PER_IMAGE, remaining),
    );
    remaining -= caption.length;
    const ocrText = normalizeExtractedText(image.ocrText).slice(
      0,
      Math.min(MAX_OCR_CHARS_PER_IMAGE, Math.max(remaining, 0)),
    );
    remaining -= ocrText.length;
    if (!caption && !ocrText && !image.altText) continue;

    const block = [
      `### 页面图片 ${index + 1}: ${sanitizeHeading(image.fileName)}`,
      `附件 ID: ${image.attachmentId}`,
      image.altText
        ? `已有替代文本: ${normalizeExtractedText(image.altText)}`
        : '',
      caption ? `图片说明: ${caption}` : '',
      ocrText ? `图片内文字:\n${ocrText}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    blocks.push(block);
    if (remaining <= 0) break;
  }
  return blocks.length > 0
    ? `## 页面图片识别内容\n\n${blocks.join('\n\n')}`
    : '';
}

function normalizeExtractedText(value: string): string {
  return value.replace(/\0/gu, '').replace(/\r\n?/gu, '\n').trim();
}

function sanitizeHeading(value: string): string {
  return normalizeExtractedText(value).replace(/[\n#]/gu, ' ').slice(0, 300);
}
