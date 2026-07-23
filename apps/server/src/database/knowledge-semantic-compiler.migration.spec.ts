import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('knowledge semantic compiler migration', () => {
  it('adds page compilation state, analysis cache, contributions, and canonical keys', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260720T130000-knowledge-semantic-compiler.ts',
      ),
      'utf8',
    );

    expect(source).toContain("createTable('knowledge_compilation_attempts')");
    expect(source).toContain("createTable('knowledge_source_analyses')");
    expect(source).toContain("createTable('knowledge_artifact_contributions')");
    expect(source).toContain("addColumn('canonical_key', 'varchar'");
    expect(source).toContain(
      'uq_knowledge_compilation_attempts_workspace_source',
    );
    expect(source).toContain('uq_knowledge_source_analyses_cache_key');
    expect(source).toContain(
      'uq_knowledge_artifact_contributions_source_artifact',
    );
    expect(source).toContain('idx_knowledge_compilation_attempts_diagnostics');
    expect(source).toContain('idx_knowledge_artifact_contributions_artifact');
  });

  it('rolls the semantic compiler schema back without touching compiled pages', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260720T130000-knowledge-semantic-compiler.ts',
      ),
      'utf8',
    );

    expect(source).toContain("dropTable('knowledge_artifact_contributions')");
    expect(source).toContain("dropTable('knowledge_source_analyses')");
    expect(source).toContain("dropTable('knowledge_compilation_attempts')");
    expect(source).toContain("dropColumn('canonical_key')");
    expect(source).not.toContain("dropTable('knowledge_pages')");
  });
});
