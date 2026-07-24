import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('knowledge link canonical targets migration', () => {
  it('stores unresolved target kind/key and indexes dangling resolution', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260724T120000-knowledge-link-canonical-targets.ts',
      ),
      'utf8',
    );

    expect(source).toContain("addColumn('target_artifact_kind', 'varchar'");
    expect(source).toContain("addColumn('target_canonical_key', 'varchar'");
    expect(source).toContain('idx_knowledge_links_canonical_target');
    expect(source).toContain('WHERE stale_at IS NULL AND is_dangling = true');
  });
});
