import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('knowledge compiler attempt metadata migration', () => {
  it('adds bounded candidate, model, quality, and generation-attempt metadata', async () => {
    const source = await readFile(
      resolve(
        __dirname,
        'migrations/20260807T110000-knowledge-compiler-attempt-metadata.ts',
      ),
      'utf8',
    );

    for (const column of [
      'compiler_model',
      'compiler_profile',
      'result_quality',
      'analysis_candidate_ids',
      'analysis_candidate_hash',
      'generation_candidate_ids',
      'generation_candidate_hash',
      'generation_attempt_source_hash',
      'generation_attempt_count',
    ]) {
      expect(source).toContain(`'${column}'`);
    }
    expect(source).toContain('generation_attempt_count BETWEEN 0 AND 3');
    expect(source).toContain("'final_aggregate', 'finalizing', 'complete'");
  });
});
