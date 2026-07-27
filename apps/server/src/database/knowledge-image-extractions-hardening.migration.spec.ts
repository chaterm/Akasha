import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('knowledge image extractions hardening migration', () => {
  it('adds a fingerprinted claim lease and bounded retry lifecycle', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260727T130000-harden-knowledge-image-extractions.ts',
      ),
      'utf8',
    );

    expect(source).toContain('cache_fingerprint');
    expect(source).toContain('lease_token');
    expect(source).toContain('lease_expires_at');
    expect(source).toContain('retryable');
    expect(source).toContain('retry_after');
    expect(source).toContain('attempt_count');
    expect(source).toContain("COALESCE(error_code, 'legacy_failure')");
    expect(source).toContain("status IN ('processing', 'ready', 'failed')");
    expect(source).toContain(
      'knowledge_image_extractions_cache_fingerprint_unique',
    );
    expect(source).toContain(
      'knowledge_image_extractions_processing_lease_idx',
    );
  });
});
