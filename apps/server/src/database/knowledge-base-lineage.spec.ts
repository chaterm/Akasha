import { readFileSync } from 'fs';
import { join } from 'path';

describe('knowledge base migration lineage constraints', () => {
  it('does not cascade-delete provenance rows when source pages are deleted', () => {
    const migration = readFileSync(
      join(
        __dirname,
        'migrations',
        '20260616T120000-knowledge-base.ts',
      ),
      'utf8',
    );

    const sourcePageForeignKeys =
      migration.match(
        /\.addColumn\('source_page_id'[\s\S]{0,160}references\('pages\.id'\)/g,
      ) ?? [];

    expect(sourcePageForeignKeys).toEqual([]);
  });
});
