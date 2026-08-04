import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('knowledge cascade foreign-key indexes migration', () => {
  it('indexes every cascade path used by force rebuild cleanup', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260804T100000-knowledge-cascade-foreign-key-indexes.ts',
      ),
      'utf8',
    );

    for (const indexName of [
      'idx_knowledge_claims_page_fk',
      'idx_knowledge_chunks_page_fk',
      'idx_knowledge_chunks_claim_fk',
      'idx_knowledge_chunks_parent_section_fk',
      'idx_knowledge_links_from_page_fk',
      'idx_knowledge_links_to_page_fk',
      'idx_knowledge_graph_edges_from_page_fk',
      'idx_knowledge_graph_edges_to_page_fk',
      'idx_knowledge_parent_sections_page_fk',
    ]) {
      expect(source).toContain(`CREATE INDEX IF NOT EXISTS ${indexName}`);
    }
  });
});
