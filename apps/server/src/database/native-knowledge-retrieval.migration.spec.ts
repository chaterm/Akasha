import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('native knowledge retrieval migration', () => {
  it('retains the previously executed pgvector extension migration', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260716T120000-enable-pgvector-knowledge-chunks.ts',
      ),
      'utf8',
    );

    expect(source).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(source).not.toContain('DROP EXTENSION');
  });

  it('retains the previously executed retrieval-quality migration', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260716T130000-knowledge-retrieval-quality.ts',
      ),
      'utf8',
    );

    expect(source).toContain('ADD COLUMN embedding_vector vector');
    expect(source).toContain('knowledge_chunks_embedding_vector_hnsw_idx');
    expect(source).toContain('knowledge_chunks_text_trgm_idx');
    expect(source).toContain('knowledge_pages_title_trgm_idx');
    expect(source).toContain('knowledge_pages_retrieval_mode_idx');
    expect(source).not.toContain('DROP EXTENSION');
  });

  it('keeps the legacy embedding while adding pgvector and full-text search', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260720T100000-native-knowledge-retrieval.ts',
      ),
      'utf8',
    );

    expect(source).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(source).toContain('RENAME COLUMN embedding TO embedding_legacy');
    expect(source).toContain('ADD COLUMN embedding vector');
    expect(source).toContain('embedding_profile');
    expect(source).toContain('embedding_model');
    expect(source).toContain('embedding_dimensions');
    expect(source).toContain('search_tsv');
    expect(source).toContain('USING GIN (search_tsv)');
    expect(source).toContain('embedding = embedding_vector');
    expect(source).toContain(
      'DROP COLUMN IF EXISTS embedding_vector',
    );
    expect(source).not.toContain('DROP EXTENSION');
  });
});
