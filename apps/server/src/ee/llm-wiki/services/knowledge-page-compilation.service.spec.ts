import { KnowledgePageCompilationService } from './knowledge-page-compilation.service';

describe('KnowledgePageCompilationService contract', () => {
  it('exposes page operations without accepting a BullMQ Job', () => {
    expect(KnowledgePageCompilationService.prototype.compileTextPage).toEqual(
      expect.any(Function),
    );
    expect(KnowledgePageCompilationService.prototype.mergePageImages).toEqual(
      expect.any(Function),
    );
    expect(
      KnowledgePageCompilationService.prototype.compileTextPage.length,
    ).toBe(2);
    expect(
      KnowledgePageCompilationService.prototype.mergePageImages.length,
    ).toBe(2);
  });
});
