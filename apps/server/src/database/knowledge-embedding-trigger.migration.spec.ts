import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('obsolete knowledge embedding trigger migration', () => {
  it('removes the trigger and function left by the temporary pgvector rollout', () => {
    const source = readFileSync(
      join(
        __dirname,
        'migrations',
        '20260724T100000-drop-obsolete-knowledge-embedding-trigger.ts',
      ),
      'utf8',
    );

    expect(source).toContain(
      'DROP TRIGGER IF EXISTS knowledge_chunks_sync_embedding_vector_trigger',
    );
    expect(source).toContain(
      'DROP FUNCTION IF EXISTS knowledge_chunks_sync_embedding_vector()',
    );
    expect(source).not.toContain('CREATE TRIGGER');
  });
});
