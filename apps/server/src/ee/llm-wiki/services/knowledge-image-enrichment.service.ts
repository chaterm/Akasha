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
import { ReadyKnowledgeImage } from './knowledge-effective-hash';

const MAX_IMAGES_PER_PAGE = 50;
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
  expected: number;
  succeeded: number;
  failed: number;
  skipped: number;
  retryableFailureCount: number;
  readyExtractionIds: string[];
  truncatedCount: number;
  imageCount: number;
  succeededCount: number;
  failedCount: number;
  cacheHitCount: number;
  warnings: KnowledgeImageEnrichmentWarning[];
  readyImages: ReadyKnowledgeImage[];
};

type ExtractedImageText = {
  attachmentId: string;
  attachmentVersion: string;
  cacheFingerprint: string;
  contentHash: string;
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

  async enrichSingleImage(
    input: {
      workspaceId: string;
      spaceId: string;
      sourcePageId: string;
      image: KnowledgeSourceImage;
    },
    abortSignal: AbortSignal,
  ): Promise<{
    status: 'succeeded' | 'failed' | 'skipped';
    extractionId?: string;
    retryable: boolean;
    errorCode?: string;
  }> {
    const result = await this.enrichSource(
      {
        workspaceId: input.workspaceId,
        spaceId: input.spaceId,
        sourcePageId: input.sourcePageId,
        sourceVersion: 'run-image',
        contentHash: 'run-image',
        title: input.image.fileName,
        text: '',
        images: [input.image],
        references: [],
      },
      { abortSignal, formatPageKnowledge: false },
    );
    if (result.succeeded > 0) {
      return {
        status: 'succeeded',
        extractionId: result.readyExtractionIds[0],
        retryable: false,
      };
    }
    const firstWarning = result.warnings.find(
      (warning) => warning.attachmentId === input.image.attachmentId,
    );
    if (result.skipped > 0 && result.failed === 0) {
      return {
        status: 'skipped',
        retryable: false,
        errorCode: firstWarning?.code ?? 'image_skipped',
      };
    }
    return {
      status: 'failed',
      retryable: result.retryableFailureCount > 0,
      errorCode: firstWarning?.code ?? 'image_processing_failed',
    };
  }

  async readReadySource(source: KnowledgeSourceSnapshot): Promise<{
    source: KnowledgeSourceSnapshot;
    readyImages: ReadyKnowledgeImage[];
    readyExtractionIds: string[];
    truncatedCount: number;
  }> {
    const images = source.images ?? [];
    if (images.length === 0) {
      return {
        source,
        readyImages: [],
        readyExtractionIds: [],
        truncatedCount: 0,
      };
    }
    const rows = await this.extractionRepo.findCurrentReadyForSnapshotImages({
      workspaceId: source.workspaceId,
      spaceId: source.spaceId,
      images: images.map((image) => ({
        sourcePageId: source.sourcePageId,
        attachmentId: image.attachmentId,
        attachmentVersion: image.attachmentVersion,
      })),
      model: this.environmentService.getAiVisionModel().trim(),
      promptVersion: DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
    });
    const rowByAttachmentId = new Map(
      rows.map((row) => [row.attachmentId, row] as const),
    );
    const extracted = images.flatMap((image): ExtractedImageText[] => {
      const row = rowByAttachmentId.get(image.attachmentId);
      if (!row || !(row.ocrText?.trim() || row.caption?.trim())) return [];
      return [
        {
          attachmentId: image.attachmentId,
          attachmentVersion: image.attachmentVersion,
          cacheFingerprint: row.cacheFingerprint,
          contentHash: row.contentHash,
          fileName: image.fileName,
          altText: image.altText,
          ocrText: row.ocrText ?? '',
          caption: row.caption ?? '',
        },
      ];
    });
    const formatted = formatImageKnowledge(extracted);
    const readyImages = extracted.map((image) => ({
      attachmentId: image.attachmentId,
      attachmentVersion: image.attachmentVersion,
      cacheFingerprint: image.cacheFingerprint,
      contentHash: image.contentHash,
      ocrText: image.ocrText,
      caption: image.caption,
    }));
    return {
      source: formatted.text
        ? {
            ...source,
            text: source.text.trim()
              ? `${source.text.trimEnd()}\n\n${formatted.text}`
              : formatted.text,
          }
        : source,
      readyImages,
      readyExtractionIds: extracted.flatMap((image) => {
        const id = rowByAttachmentId.get(image.attachmentId)?.id;
        return id ? [id] : [];
      }),
      truncatedCount: formatted.truncatedCount,
    };
  }

  async enrichSource(
    source: KnowledgeSourceSnapshot,
    options?: {
      abortSignal?: AbortSignal;
      formatPageKnowledge?: boolean;
    },
  ): Promise<KnowledgeImageEnrichmentResult> {
    options?.abortSignal?.throwIfAborted();
    const allSourceImages = source.images ?? [];
    const sourceImages = allSourceImages.slice(0, MAX_IMAGES_PER_PAGE);
    const warnings: KnowledgeImageEnrichmentWarning[] = [];
    let failed = 0;
    let skipped = Math.max(0, allSourceImages.length - sourceImages.length);
    let retryableFailureCount = 0;
    const readyExtractionIds: string[] = [];
    if (allSourceImages.length > MAX_IMAGES_PER_PAGE) {
      warnings.push({
        attachmentId: '',
        code: 'skipped_limit',
        message: `${allSourceImages.length - MAX_IMAGES_PER_PAGE} page images exceeded the ${MAX_IMAGES_PER_PAGE}-image safety limit and were terminally skipped.`,
      });
    }
    if (sourceImages.length === 0) {
      return emptyResult(source, warnings, allSourceImages.length, skipped);
    }
    if (!this.imageProvider.isConfigured()) {
      return {
        ...emptyResult(source, warnings, allSourceImages.length, skipped),
        imageCount: sourceImages.length,
        failed: sourceImages.length,
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
        skipped += 1;
        continue;
      }
      if (
        attachment.fileSize !== null &&
        Number(attachment.fileSize) > MAX_IMAGE_BYTES
      ) {
        warnings.push(warning(image.attachmentId, 'image_too_large'));
        failed += 1;
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = options?.abortSignal
          ? await this.storageService.read(attachment.filePath, {
              abortSignal: options.abortSignal,
            })
          : await this.storageService.read(attachment.filePath);
      } catch (error) {
        if (options?.abortSignal?.aborted) {
          throw options.abortSignal.reason ?? error;
        }
        warnings.push(warning(image.attachmentId, 'image_unreadable'));
        failed += 1;
        retryableFailureCount += 1;
        continue;
      }
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
        warnings.push(
          warning(
            image.attachmentId,
            bytes.length === 0 ? 'image_empty' : 'image_too_large',
          ),
        );
        failed += 1;
        continue;
      }

      const detectedMime = sniffRasterMime(bytes);
      if (!detectedMime) {
        warnings.push(warning(image.attachmentId, 'unsupported_image'));
        failed += 1;
        continue;
      }

      const contentHash = hash(bytes);
      const cacheKey = {
        workspaceId: source.workspaceId,
        attachmentId: image.attachmentId,
        attachmentVersion: attachment.updatedAt,
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
        failed += 1;
        retryableFailureCount += 1;
        continue;
      }

      if (claim.state === 'ready') {
        cacheHitCount += 1;
        const appended = appendCachedExtraction(
          extracted,
          image,
          claim.extraction,
        );
        if (
          !claim.extraction.ocrText?.trim() &&
          !claim.extraction.caption?.trim()
        ) {
          warnings.push(warning(image.attachmentId, 'image_no_content'));
          skipped += 1;
        } else if (appended) {
          readyExtractionIds.push(claim.extraction.id);
        }
        continue;
      }
      if (claim.state === 'busy') {
        warnings.push(
          warning(image.attachmentId, 'image_processing_in_progress'),
        );
        failed += 1;
        retryableFailureCount += 1;
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
        failed += 1;
        if (claim.extraction.retryable) retryableFailureCount += 1;
        continue;
      }

      try {
        const normalized = await normalizeForVision(
          bytes,
          detectedMime,
          options?.abortSignal,
        );
        const providerInput = {
          bytes: normalized.bytes,
          mimeType: normalized.mimeType,
          fileName: image.fileName,
          altText: image.altText,
        };
        const result = options?.abortSignal
          ? await this.imageProvider.describe(
              providerInput,
              options.abortSignal,
            )
          : await this.imageProvider.describe(providerInput);
        const ocrText = normalizeExtractedText(result.ocrText).slice(
          0,
          MAX_OCR_CHARS_PER_IMAGE,
        );
        const caption = normalizeExtractedText(result.caption).slice(
          0,
          MAX_CAPTION_CHARS_PER_IMAGE,
        );
        options?.abortSignal?.throwIfAborted();
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
          skipped += 1;
          continue;
        }
        if (!ocrText && !caption) {
          warnings.push(warning(image.attachmentId, 'image_no_content'));
          skipped += 1;
          continue;
        }
        readyExtractionIds.push(published.id);
        extracted.push({
          attachmentId: image.attachmentId,
          attachmentVersion: image.attachmentVersion,
          cacheFingerprint: cacheKey.cacheFingerprint,
          contentHash: cacheKey.contentHash,
          fileName: image.fileName,
          altText: image.altText,
          ocrText,
          caption,
        });
      } catch (error) {
        if (options?.abortSignal?.aborted) {
          throw options.abortSignal.reason ?? error;
        }
        const failure = imageFailure(error);
        failed += 1;
        if (failure.retryable) retryableFailureCount += 1;
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

    options?.abortSignal?.throwIfAborted();
    const formatted =
      options?.formatPageKnowledge === false
        ? { text: '', truncatedCount: 0 }
        : formatImageKnowledge(extracted);
    if (formatted.truncatedCount > 0) {
      warnings.push({
        attachmentId: '',
        code: 'image_text_budget_truncated',
        message: `${formatted.truncatedCount} image extractions were truncated by the page image text budget.`,
      });
    }
    return {
      source: formatted.text
        ? {
            ...source,
            text: source.text.trim()
              ? `${source.text.trimEnd()}\n\n${formatted.text}`
              : formatted.text,
          }
        : source,
      expected: allSourceImages.length,
      succeeded: extracted.length,
      failed,
      skipped,
      retryableFailureCount,
      readyExtractionIds,
      truncatedCount: formatted.truncatedCount,
      imageCount: sourceImages.length,
      succeededCount: extracted.length,
      failedCount: failed,
      cacheHitCount,
      warnings,
      readyImages: extracted.map((image) => ({
        attachmentId: image.attachmentId,
        attachmentVersion: image.attachmentVersion,
        cacheFingerprint: image.cacheFingerprint,
        contentHash: image.contentHash,
        ocrText: image.ocrText,
        caption: image.caption,
      })),
    };
  }
}

function emptyResult(
  source: KnowledgeSourceSnapshot,
  warnings: KnowledgeImageEnrichmentWarning[],
  expected = 0,
  skipped = 0,
): KnowledgeImageEnrichmentResult {
  return {
    source,
    expected,
    succeeded: 0,
    failed: 0,
    skipped,
    retryableFailureCount: 0,
    readyExtractionIds: [],
    truncatedCount: 0,
    imageCount: 0,
    succeededCount: 0,
    failedCount: 0,
    cacheHitCount: 0,
    warnings,
    readyImages: [],
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
  cached: {
    cacheFingerprint: string;
    contentHash: string;
    ocrText: string | null;
    caption: string | null;
  },
): boolean {
  const ocrText = cached.ocrText ?? '';
  const caption = cached.caption ?? '';
  if (!ocrText.trim() && !caption.trim()) return false;
  extracted.push({
    attachmentId: image.attachmentId,
    attachmentVersion: image.attachmentVersion,
    cacheFingerprint: cached.cacheFingerprint,
    contentHash: cached.contentHash,
    fileName: image.fileName,
    altText: image.altText,
    ocrText,
    caption,
  });
  return true;
}

async function normalizeForVision(
  bytes: Buffer,
  detectedMime: SupportedRasterMime,
  abortSignal?: AbortSignal,
): Promise<NormalizedImage> {
  try {
    abortSignal?.throwIfAborted();
    const input = sharp(bytes, {
      animated: false,
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS,
    });
    const metadata = await input.metadata();
    abortSignal?.throwIfAborted();
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
    abortSignal?.throwIfAborted();
    let mimeType: NormalizedImage['mimeType'] = preferJpeg
      ? 'image/jpeg'
      : 'image/png';

    if (normalized.length > MAX_NORMALIZED_IMAGE_BYTES) {
      normalized = await sharp(normalized)
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer();
      abortSignal?.throwIfAborted();
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

function formatImageKnowledge(images: ExtractedImageText[]): {
  text: string;
  truncatedCount: number;
} {
  let remaining = MAX_ENRICHMENT_CHARS_PER_PAGE;
  const blocks: string[] = [];
  let truncatedCount = 0;
  for (const [index, image] of images.entries()) {
    const fullCaption = normalizeExtractedText(image.caption).slice(
      0,
      MAX_CAPTION_CHARS_PER_IMAGE,
    );
    const caption = fullCaption.slice(
      0,
      Math.min(MAX_CAPTION_CHARS_PER_IMAGE, remaining),
    );
    remaining -= caption.length;
    const fullOcrText = normalizeExtractedText(image.ocrText).slice(
      0,
      MAX_OCR_CHARS_PER_IMAGE,
    );
    const ocrText = fullOcrText.slice(
      0,
      Math.min(MAX_OCR_CHARS_PER_IMAGE, Math.max(remaining, 0)),
    );
    remaining -= ocrText.length;
    if (
      caption.length < fullCaption.length ||
      ocrText.length < fullOcrText.length
    ) {
      truncatedCount += 1;
    }
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
    if (remaining <= 0) {
      truncatedCount += images
        .slice(index + 1)
        .filter(
          (remainingImage) =>
            normalizeExtractedText(remainingImage.caption).length > 0 ||
            normalizeExtractedText(remainingImage.ocrText).length > 0,
        ).length;
      break;
    }
  }
  return {
    text:
      blocks.length > 0 ? `## 页面图片识别内容\n\n${blocks.join('\n\n')}` : '',
    truncatedCount,
  };
}

function normalizeExtractedText(value: string): string {
  return value.replace(/\0/gu, '').replace(/\r\n?/gu, '\n').trim();
}

function sanitizeHeading(value: string): string {
  return normalizeExtractedText(value).replace(/[\n#]/gu, ' ').slice(0, 300);
}
