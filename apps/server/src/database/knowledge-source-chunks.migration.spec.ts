import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('knowledge source chunks retrieval migration', () => {
  it('indexes the workspace and source page lookup used by raw evidence reads', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260727T100000-index-knowledge-source-chunks.ts',
      ),
      'utf8',
    );

    expect(source).toContain('idx_knowledge_source_chunks_page');
    expect(source).toContain('workspace_id, source_page_id, created_at DESC');
  });
});
