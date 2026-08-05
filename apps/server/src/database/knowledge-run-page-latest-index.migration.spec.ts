import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('knowledge RunPage latest-source index migration', () => {
  it('indexes the workspace-scoped latest-page lookup used by diagnostics', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260805T110000-knowledge-run-page-latest-index.ts',
      ),
      'utf8',
    );

    expect(source).toContain(
      'CREATE INDEX IF NOT EXISTS idx_knowledge_run_pages_latest_source',
    );
    expect(source).toContain('workspace_id');
    expect(source).toContain('source_page_id');
    expect(source).toContain('updated_at DESC');
    expect(source).toContain('id DESC');
    expect(source).toContain(
      'DROP INDEX IF EXISTS idx_knowledge_run_pages_latest_source',
    );
  });
});
