import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import { KnowledgeImageExtractionRepo } from '@akasha/db/repos/llm-wiki/knowledge-image-extraction.repo';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { StorageService } from '../../../integrations/storage/storage.service';
import {
  KnowledgeSourceImage,
  KnowledgeSourceSnapshot,
} from '../types/source-snapshot.types';
import {
  KnowledgeImageUnderstandingError,
  KnowledgeImageUnderstandingProvider,
} from './knowledge-image-understanding-provider.service';
import { KnowledgeImageEnrichmentService } from './knowledge-image-enrichment.service';

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const gifBytes = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'base64',
);

describe('KnowledgeImageEnrichmentService', () => {
  it('uses a ready leased cache entry and appends searchable image text', async () => {
    const fixture = createFixture();
    fixture.extractionRepo.claim.mockResolvedValue({
      state: 'ready',
      extraction: extraction({
        status: 'ready',
        ocrText: '数据库连接超时',
        caption: '监控面板显示连接池耗尽',
      }),
    });

    const result = await fixture.service.enrichSource(source());

    expect(result.succeededCount).toBe(1);
    expect(result.cacheHitCount).toBe(1);
    expect(result.source.text).toContain('页面图片识别内容');
    expect(result.source.text).toContain('数据库连接超时');
    expect(result.source.text).toContain('监控面板显示连接池耗尽');
    expect(fixture.provider.describe).not.toHaveBeenCalled();
  });

  it('normalizes an owned image, invokes the model, and publishes under its lease', async () => {
    const fixture = createFixture();
    fixture.provider.describe.mockResolvedValue({
      ocrText: 'Error rate 8%',
      caption: 'A service reliability dashboard.',
    });

    const result = await fixture.service.enrichSource(source('正文'));

    expect(fixture.storageService.read).toHaveBeenCalledWith(
      'workspace-1/image-1/dashboard.png',
    );
    expect(fixture.provider.describe).toHaveBeenCalledWith({
      bytes: expect.any(Buffer),
      mimeType: 'image/png',
      fileName: 'dashboard.png',
      altText: 'Dashboard',
    });
    const providerBytes = fixture.provider.describe.mock.calls[0][0].bytes;
    expect(providerBytes.subarray(0, 8)).toEqual(pngBytes.subarray(0, 8));
    expect(fixture.extractionRepo.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        attachmentId: 'image-1',
        cacheFingerprint: expect.stringMatching(/^sha256:/),
        model: 'qwen3.7-plus',
        promptVersion: 'akasha-page-image-understanding-v1',
      }),
      150_000,
    );
    expect(fixture.extractionRepo.completeSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        extractionId: 'extraction-1',
        leaseToken: 'lease-1',
        mimeType: 'image/png',
        ocrText: 'Error rate 8%',
      }),
    );
    expect(result.source.text).toContain('正文');
    expect(result.source.text).toContain('Error rate 8%');
  });

  it('converts a GIF first frame to PNG before calling the vision model', async () => {
    const fixture = createFixture({ bytes: gifBytes });
    fixture.provider.describe.mockResolvedValue({
      ocrText: '',
      caption: 'A small graphic.',
    });

    await fixture.service.enrichSource(
      source('', { mimeType: 'image/gif', fileName: 'pixel.gif' }),
    );

    expect(fixture.provider.describe).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'image/png' }),
    );
  });

  it('keeps normal page text compilable and applies backoff when one image fails', async () => {
    const fixture = createFixture();
    fixture.provider.describe.mockRejectedValue(
      new KnowledgeImageUnderstandingError(
        'timeout',
        'Knowledge image understanding provider timed out.',
        true,
      ),
    );

    const result = await fixture.service.enrichSource(source('正文仍然可用'));

    expect(result.source.text).toBe('正文仍然可用');
    expect(result.failedCount).toBe(1);
    expect(result.warnings).toEqual([
      expect.objectContaining({ attachmentId: 'image-1', code: 'timeout' }),
    ]);
    expect(fixture.extractionRepo.completeFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        extractionId: 'extraction-1',
        leaseToken: 'lease-1',
        errorCode: 'timeout',
        retryable: true,
        retryAfter: expect.any(Date),
      }),
    );
  });

  it('does not retry a failure still in database backoff', async () => {
    const fixture = createFixture();
    fixture.extractionRepo.claim.mockResolvedValue({
      state: 'failed',
      extraction: extraction({
        status: 'failed',
        retryable: true,
        retryAfter: new Date(Date.now() + 30_000),
        errorCode: 'timeout',
      }),
    });

    const result = await fixture.service.enrichSource(source('正文'));

    expect(fixture.provider.describe).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'image_retry_backoff' }),
    ]);
  });

  it('rejects spoofed non-image bytes before claiming or calling the model', async () => {
    const fixture = createFixture({ bytes: Buffer.from('<svg></svg>') });

    const result = await fixture.service.enrichSource(source('正文'));

    expect(fixture.extractionRepo.claim).not.toHaveBeenCalled();
    expect(fixture.provider.describe).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'unsupported_image' }),
    ]);
  });

  it('does not read an attachment whose ownership or version no longer matches', async () => {
    const fixture = createFixture({ pageId: 'other-page' });

    const result = await fixture.service.enrichSource(source());

    expect(fixture.storageService.read).not.toHaveBeenCalled();
    expect(fixture.provider.describe).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'image_changed' }),
    ]);
  });

  it('degrades safely when the vision provider is not configured', async () => {
    const fixture = createFixture();
    fixture.provider.isConfigured.mockReturnValue(false);

    const result = await fixture.service.enrichSource(source('正文'));

    expect(result.source.text).toBe('正文');
    expect(result.failedCount).toBe(1);
    expect(result.warnings[0]?.code).toBe('vision_model_not_configured');
    expect(fixture.attachmentRepo.findByIds).not.toHaveBeenCalled();
  });
});

function source(
  text = '',
  overrides: Partial<KnowledgeSourceImage> = {},
): KnowledgeSourceSnapshot {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'page-1',
    sourceVersion: '2026-07-27T00:00:00.000Z',
    contentHash: 'sha256:page',
    title: 'Dashboard',
    text,
    images: [
      {
        attachmentId: 'image-1',
        fileName: 'dashboard.png',
        mimeType: 'image/png',
        fileSize: 1024,
        attachmentVersion: '2026-07-27T00:01:00.000Z',
        altText: 'Dashboard',
        ...overrides,
      },
    ],
    references: [],
  };
}

function extraction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'extraction-1',
    status: 'processing',
    attemptCount: 1,
    ocrText: null,
    caption: null,
    retryable: null,
    retryAfter: null,
    errorCode: null,
    ...overrides,
  };
}

function createFixture(overrides?: { pageId?: string; bytes?: Buffer }) {
  const attachmentRepo = {
    findByIds: jest.fn().mockResolvedValue([
      {
        id: 'image-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        pageId: overrides?.pageId ?? 'page-1',
        type: 'file',
        fileName: 'dashboard.png',
        filePath: 'workspace-1/image-1/dashboard.png',
        fileExt: '.png',
        fileSize: 1024,
        mimeType: 'image/png',
        updatedAt: new Date('2026-07-27T00:01:00.000Z'),
        deletedAt: null,
      },
    ]),
  };
  const extractionRepo = {
    claim: jest.fn().mockResolvedValue({
      state: 'claimed',
      extraction: extraction(),
      leaseToken: 'lease-1',
    }),
    completeSuccess: jest
      .fn()
      .mockResolvedValue(extraction({ status: 'ready' })),
    completeFailure: jest
      .fn()
      .mockResolvedValue(extraction({ status: 'failed' })),
  };
  const storageService = {
    read: jest.fn().mockResolvedValue(overrides?.bytes ?? pngBytes),
  };
  const environmentService = {
    getAiVisionModel: jest.fn().mockReturnValue('qwen3.7-plus'),
    getKnowledgeImageTimeoutMs: jest.fn().mockReturnValue(120_000),
  };
  const provider = {
    isConfigured: jest.fn().mockReturnValue(true),
    getCacheIdentity: jest.fn().mockReturnValue('sha256:provider-identity'),
    describe: jest.fn(),
  };
  const service = new KnowledgeImageEnrichmentService(
    attachmentRepo as unknown as AttachmentRepo,
    extractionRepo as unknown as KnowledgeImageExtractionRepo,
    storageService as unknown as StorageService,
    environmentService as unknown as EnvironmentService,
    provider as unknown as KnowledgeImageUnderstandingProvider,
  );
  return {
    service,
    attachmentRepo,
    extractionRepo,
    storageService,
    environmentService,
    provider,
  };
}
