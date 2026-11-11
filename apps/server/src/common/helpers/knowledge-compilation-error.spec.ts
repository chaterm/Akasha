import { PostgresError } from 'postgres';
import {
  compilationFailureMessage,
  describeKnowledgeCompilationError,
  runKnowledgeCompilationOperation,
} from './knowledge-compilation-error';

describe('knowledge compilation error diagnostics', () => {
  it('keeps the original error and the closest failing operation', async () => {
    const error = new TypeError('Cannot read properties of undefined');
    await expect(
      runKnowledgeCompilationOperation('import.transaction', () =>
        runKnowledgeCompilationOperation(
          'import.replace_source_chunks',
          async () => {
            throw error;
          },
        ),
      ),
    ).rejects.toBe(error);
    expect(describeKnowledgeCompilationError(error).operation).toBe(
      'import.replace_source_chunks',
    );
  });

  it('retains database metadata without serializing source data or SQL parameters', () => {
    const error = Object.assign(new PostgresError(''), {
      message: 'invalid input syntax: sensitive-page-text',
      code: '23505',
      schema_name: 'public',
      table_name: 'knowledge_pages',
      constraint_name: 'uq_knowledge_pages_canonical_key',
      detail: 'sensitive-page-text',
      query: 'INSERT sensitive-page-text',
      parameters: ['sensitive-page-text'],
      where: 'sensitive-page-text',
      stack:
        'PostgresError: sensitive-page-text\n    at publish (import.ts:1:2)',
    });
    const diagnostic = describeKnowledgeCompilationError(error);
    expect(diagnostic.database).toMatchObject({
      sqlState: '23505',
      table: 'knowledge_pages',
      constraint: 'uq_knowledge_pages_canonical_key',
    });
    expect(diagnostic.errorMessage).toContain('sqlState=23505');
    expect(diagnostic.stackFrames).toContain('import.ts:1:2');
    expect(JSON.stringify(diagnostic)).not.toContain('sensitive-page-text');
  });

  it('records the incoming artifact id for a failed knowledge-page upsert', async () => {
    const error = new Error('upsert failed');
    await runKnowledgeCompilationOperation(
      'import.upsert_knowledge_page',
      async () => {
        throw error;
      },
      { artifactId: 'incoming-artifact-id' },
    ).catch(() => {});
    expect(describeKnowledgeCompilationError(error)).toMatchObject({
      operation: 'import.upsert_knowledge_page',
      artifactId: 'incoming-artifact-id',
    });
    expect(compilationFailureMessage(error, 'upsert failed')).toContain(
      'artifactId=incoming-artifact-id',
    );
  });

  it('redacts credentials while retaining ordinary error reasons', () => {
    const diagnostic = describeKnowledgeCompilationError(
      new Error(
        'Connection failed: postgres://user:pass@host/db password="my password" token=abc Bearer xyz',
      ),
    );
    expect(diagnostic.errorMessage).toContain('Connection failed');
    for (const secret of ['user:pass', 'my password', 'abc', 'xyz']) {
      expect(diagnostic.errorMessage).not.toContain(secret);
    }
  });

  it('handles non-Error throws without serializing their contents', async () => {
    const error = { body: 'sensitive-page-text' };
    await expect(
      runKnowledgeCompilationOperation('compile', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(describeKnowledgeCompilationError(error)).toMatchObject({
      operation: 'compile',
      errorName: 'UnknownError',
    });
    expect(
      JSON.stringify(describeKnowledgeCompilationError(error)),
    ).not.toContain('sensitive-page-text');
    expect(describeKnowledgeCompilationError(null).errorName).toBe(
      'UnknownError',
    );
  });

  it('bounds persisted messages and retains the failing operation', async () => {
    const error = new Error('x'.repeat(1000));
    await runKnowledgeCompilationOperation('import.upsert_source', async () => {
      throw error;
    }).catch(() => {});
    const message = compilationFailureMessage(error, 'x'.repeat(1000));
    expect(message).toHaveLength(500);
    expect(message).toMatch(/^\[import.upsert_source\]/);
  });
});
