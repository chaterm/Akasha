import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('knowledge image extractions migration', () => {
  it('creates a workspace-scoped, versioned image extraction cache', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260727T120000-knowledge-image-extractions.ts',
      ),
      'utf8',
    );

    expect(source).toContain("createTable('knowledge_image_extractions')");
    expect(source).toContain("addColumn('attachment_id'");
    expect(source).toContain("addColumn('content_hash'");
    expect(source).toContain("addColumn('model'");
    expect(source).toContain("addColumn('prompt_version'");
    expect(source).toContain("addColumn('status'");
    expect(source).toContain("addColumn('mime_type'");
    expect(source).toContain("addColumn('file_name'");
    expect(source).toContain("addColumn('ocr_text'");
    expect(source).toContain("addColumn('caption'");
    expect(source).toContain("addColumn('error_code'");
    expect(source).toContain("addColumn('error_message'");
    expect(source).toContain('knowledge_image_extractions_cache_key_unique');
    expect(source).toContain("'workspace_id',");
    expect(source).toContain("'attachment_id',");
    expect(source).toContain("'content_hash',");
    expect(source).toContain("'model',");
    expect(source).toContain("'prompt_version',");
    expect(source).toContain("status IN ('ready', 'failed')");
  });
});
