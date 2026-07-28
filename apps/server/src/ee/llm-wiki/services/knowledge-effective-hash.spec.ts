import { buildEffectiveKnowledgeHash } from './knowledge-effective-hash';

const input = {
  sourceContentHash: 'sha256:source',
  compilerVersion: 'semantic-v1',
  promptVersion: 'semantic-prompt-v1',
  readyImages: [
    {
      attachmentId: 'attachment-1',
      attachmentVersion: '2026-07-28T08:00:00.000Z',
      cacheFingerprint: 'sha256:image-cache-1',
      contentHash: 'sha256:image-content-1',
      ocrText: '数据库连接超时',
      caption: '监控面板显示连接池耗尽',
    },
    {
      attachmentId: 'attachment-2',
      attachmentVersion: '2026-07-28T08:01:00.000Z',
      cacheFingerprint: 'sha256:image-cache-2',
      contentHash: 'sha256:image-content-2',
      ocrText: 'Error rate 8%',
      caption: 'A service reliability dashboard.',
    },
  ],
};

describe('buildEffectiveKnowledgeHash', () => {
  it('returns the same sha256 hash for identical ordered inputs', () => {
    const first = buildEffectiveKnowledgeHash(input);
    const second = buildEffectiveKnowledgeHash({
      ...input,
      readyImages: input.readyImages.map((image) => ({ ...image })),
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it.each([
    ['OCR text', { ocrText: '数据库连接已恢复' }],
    ['caption', { caption: '监控面板显示服务已恢复' }],
    ['attachment version', { attachmentVersion: 'v2' }],
    ['cache fingerprint', { cacheFingerprint: 'sha256:new-cache' }],
    ['content hash', { contentHash: 'sha256:new-content' }],
  ])('changes when ready-image %s changes', (_label, changedImage) => {
    const changed = buildEffectiveKnowledgeHash({
      ...input,
      readyImages: [
        { ...input.readyImages[0], ...changedImage },
        input.readyImages[1],
      ],
    });

    expect(changed).not.toBe(buildEffectiveKnowledgeHash(input));
  });

  it('changes when the source content hash changes', () => {
    expect(
      buildEffectiveKnowledgeHash({
        ...input,
        sourceContentHash: 'sha256:changed-source',
      }),
    ).not.toBe(buildEffectiveKnowledgeHash(input));
  });

  it('changes when a ready-image attachment identity changes', () => {
    expect(
      buildEffectiveKnowledgeHash({
        ...input,
        readyImages: [
          {
            ...input.readyImages[0],
            attachmentId: 'replacement-attachment',
          },
          input.readyImages[1],
        ],
      }),
    ).not.toBe(buildEffectiveKnowledgeHash(input));
  });

  it('changes when ready-image order changes', () => {
    expect(
      buildEffectiveKnowledgeHash({
        ...input,
        readyImages: [...input.readyImages].reverse(),
      }),
    ).not.toBe(buildEffectiveKnowledgeHash(input));
  });

  it.each([
    ['compiler version', { compilerVersion: 'semantic-v2' }],
    ['prompt version', { promptVersion: 'semantic-prompt-v2' }],
  ])('changes when the %s changes', (_label, changedInput) => {
    expect(buildEffectiveKnowledgeHash({ ...input, ...changedInput })).not.toBe(
      buildEffectiveKnowledgeHash(input),
    );
  });

  it('hashes only the caller-provided ready images and never returns their text', () => {
    const textOnly = buildEffectiveKnowledgeHash({
      ...input,
      readyImages: [],
    });
    const withReadyImages = buildEffectiveKnowledgeHash(input);

    expect(textOnly).not.toBe(withReadyImages);
    expect(withReadyImages).not.toContain(input.readyImages[0].ocrText);
    expect(withReadyImages).not.toContain(input.readyImages[0].caption);
  });
});
