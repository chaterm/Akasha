import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('knowledge chunk embedding usage migration', () => {
  it('adds non-negative embedding usage columns to knowledge chunks', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20261014T100000-knowledge-chunk-embedding-usage.ts',
      ),
      'utf8',
    );

    expect(source).toContain("addColumn('embedding_total_tokens', 'integer')");
    expect(source).toContain("addColumn('embedding_duration_ms', 'integer')");
    expect(source).toContain('knowledge_chunks_embedding_usage_check');
    expect(source).toContain('embedding_total_tokens IS NULL');
    expect(source).toContain('embedding_duration_ms IS NULL');
    expect(source).toContain("dropColumn('embedding_duration_ms')");
    expect(source).toContain("dropColumn('embedding_total_tokens')");
  });
});
