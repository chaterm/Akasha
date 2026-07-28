import { createHash } from 'node:crypto';

export type ReadyKnowledgeImage = {
  attachmentId: string;
  attachmentVersion: string;
  cacheFingerprint: string;
  contentHash: string;
  ocrText: string;
  caption: string;
};

export type EffectiveKnowledgeHashInput = {
  sourceContentHash: string;
  /** Final source text digest used by compatibility callers without images. */
  sourceTextHash?: string;
  compilerVersion: string;
  promptVersion: string;
  readyImages: ReadyKnowledgeImage[];
};

/**
 * Hashes every input that can change the published page knowledge. Image order
 * is intentional because the generated Wiki preserves page traversal order.
 */
export function buildEffectiveKnowledgeHash(
  input: EffectiveKnowledgeHashInput,
): string {
  const payload = [
    'akasha-effective-knowledge-v1',
    input.sourceContentHash,
    input.sourceTextHash ?? null,
    input.compilerVersion,
    input.promptVersion,
    input.readyImages.map((image) => [
      image.attachmentId,
      image.attachmentVersion,
      image.cacheFingerprint,
      image.contentHash,
      digest(image.ocrText),
      digest(image.caption),
    ]),
  ];

  return digest(JSON.stringify(payload));
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
