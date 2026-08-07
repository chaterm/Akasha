import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('knowledge retirement durable contributions migration', () => {
  it('keeps hard-deleted source contributions until fenced retirement', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260807T120000-knowledge-retirement-durable-contributions.ts',
      ),
      'utf8',
    );

    expect(source).toContain(
      'DROP CONSTRAINT IF EXISTS\n        knowledge_artifact_contributions_source_page_id_fkey',
    );
    expect(source).toContain(
      'Cannot restore contribution cascade FK while retired source rows remain',
    );
    expect(source).toContain('FOREIGN KEY (source_page_id)');
    expect(source).toContain('ON DELETE CASCADE');
    expect(source).not.toContain(
      'DELETE FROM knowledge_artifact_contributions',
    );
  });
});
