import { validate } from 'class-validator';
import { CancelKnowledgeRunDto } from './cancel-knowledge-run.dto';

describe('CancelKnowledgeRunDto', () => {
  it('accepts an omitted or bounded operator reason', async () => {
    await expect(validate(new CancelKnowledgeRunDto())).resolves.toEqual([]);
    const dto = Object.assign(new CancelKnowledgeRunDto(), {
      reason: 'Capacity test completed.',
    });
    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('rejects an oversized reason', async () => {
    const dto = Object.assign(new CancelKnowledgeRunDto(), {
      reason: 'x'.repeat(401),
    });
    await expect(validate(dto)).resolves.not.toEqual([]);
  });
});
