import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('knowledge RunPage binding migration', () => {
  it('adds an explicit nullable-until-bound source and image plan', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260807T100000-knowledge-run-page-binding.ts',
      ),
      'utf8',
    );

    expect(source).toContain("addColumn('binding_status'");
    expect(source).toContain("addColumn('discovered_source_version'");
    expect(source).toContain("addColumn('quality_status'");
    expect(source).toContain("addColumn('reused'");
    expect(source).toContain("alterColumn('expected_source_version'");
    expect(source).toContain("alterColumn('expected_source_content_hash'");
    expect(source).toContain("alterColumn('expected_image_count'");
    expect(source).toContain('chk_knowledge_space_compile_run_pages_binding');
    expect(source).toContain("binding_status IN ('unbound', 'binding')");
    expect(source).toContain("binding_status = 'bound'");
    expect(source).toContain('expected_image_count IS NULL');
    expect(source).toContain('expected_image_count IS NOT NULL');
  });

  it('fails rollback safely while unbound rows still exist', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260807T100000-knowledge-run-page-binding.ts',
      ),
      'utf8',
    );

    expect(source).toContain('Cannot roll back RunPage binding migration');
    expect(source).not.toContain(
      'DELETE FROM knowledge_space_compile_run_pages',
    );
  });
});
