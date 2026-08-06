import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('pending knowledge embedding publication migration', () => {
  it('stores compiler output outside searchable knowledge tables', () => {
    const source = readFileSync(
      join(
        __dirname,
        'migrations/20260806T100000-knowledge-pending-embedding-publication.ts',
      ),
      'utf8',
    );

    expect(source).toContain("alterTable('knowledge_compilation_attempts')");
    expect(source).toContain("addColumn('pending_import', 'jsonb')");
    expect(source).toContain("addColumn('pending_source_version', 'varchar')");
    expect(source).toContain(
      "addColumn('pending_effective_knowledge_hash', 'varchar')",
    );
    expect(source).not.toContain("alterTable('knowledge_pages')");
    expect(source).not.toContain("alterTable('knowledge_chunks')");
  });
});
