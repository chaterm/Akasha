import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('active space compile run migration', () => {
  it('supersedes historical duplicate active runs before adding a partial unique index', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260727T110000-active-space-compile-run.ts',
      ),
      'utf8',
    );

    expect(source).toContain(
      'PARTITION BY workspace_id, space_id ORDER BY created_at DESC, id DESC',
    );
    expect(source).toContain('WHERE active_rank > 1');
    expect(source).toContain('UPDATE knowledge_space_compile_run_pages');
    expect(source).toContain("error_code = 'run_superseded'");
    expect(source).toContain('skipped_page_count =');
    expect(source).toContain("status = 'superseded'");
    expect(source).toContain('uq_knowledge_space_compile_runs_active_space');
    expect(source).toContain(
      'ON knowledge_space_compile_runs (workspace_id, space_id)',
    );
    expect(source).toContain(
      "WHERE status IN ('queued', 'compiling', 'aggregate_pending', 'aggregating')",
    );
  });

  it('drops the active-run index on rollback', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260727T110000-active-space-compile-run.ts',
      ),
      'utf8',
    );

    expect(source).toContain(
      'DROP INDEX IF EXISTS uq_knowledge_space_compile_runs_active_space',
    );
  });
});
