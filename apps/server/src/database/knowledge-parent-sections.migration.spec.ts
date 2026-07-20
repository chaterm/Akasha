import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('knowledge parent sections migration', () => {
  it('persists structural parents and channel-aware child metadata', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260720T110000-knowledge-parent-sections.ts',
      ),
      'utf8',
    );

    expect(source).toContain('CREATE TABLE knowledge_parent_sections');
    expect(source).toContain('CREATE TABLE knowledge_parent_section_sources');
    expect(source).toContain('parent_section_id');
    expect(source).toContain('stable_key');
    expect(source).toContain('chunk_role');
    expect(source).toContain('retrieval_channel');
    expect(source).toContain("IN ('evidence', 'memory')");
    expect(source).toContain('heading_path');
    expect(source).toContain('start_offset');
    expect(source).toContain('end_offset');
    expect(source).toContain(
      'UNIQUE (workspace_id, knowledge_page_id, stable_key)',
    );
  });
});
