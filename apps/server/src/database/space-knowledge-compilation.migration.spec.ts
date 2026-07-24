import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('space knowledge compilation migration', () => {
  it('adds durable space runs and page barrier rows with dispatch indexes', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260724T110000-space-knowledge-compilation-runs.ts',
      ),
      'utf8',
    );

    expect(source).toContain("createTable('knowledge_space_compile_runs')");
    expect(source).toContain(
      "createTable('knowledge_space_compile_run_pages')",
    );
    expect(source).toContain('uq_knowledge_space_compile_run_pages_run_page');
    expect(source).toContain('idx_knowledge_space_compile_runs_dispatch');
    expect(source).toContain('idx_knowledge_space_compile_run_pages_dispatch');
    expect(source).toContain("addColumn('catalog_snapshot', 'jsonb'");
    expect(source).toContain("addColumn('catalog_hash', 'varchar'");
    expect(source).toContain("addColumn('expected_source_version', 'varchar'");
    expect(source).toContain(
      "addColumn('expected_source_content_hash', 'varchar'",
    );
  });

  it('drops page barrier rows before their parent runs', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260724T110000-space-knowledge-compilation-runs.ts',
      ),
      'utf8',
    );

    expect(
      source.indexOf("dropTable('knowledge_space_compile_run_pages')"),
    ).toBeLessThan(source.indexOf("dropTable('knowledge_space_compile_runs')"));
  });
});
