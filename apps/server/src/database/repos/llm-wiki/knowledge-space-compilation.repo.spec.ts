import { decideSpaceRunRequest } from './knowledge-space-compilation.repo';

describe('decideSpaceRunRequest', () => {
  it('creates only when no active run exists', () => {
    expect(decideSpaceRunRequest(undefined)).toBe('created');
  });

  it('coalesces only a queued, uninitialized text run', () => {
    expect(
      decideSpaceRunRequest({
        status: 'queued',
        phase: 'text',
        initializedAt: null,
      }),
    ).toBe('coalesced');
  });

  it.each([
    { status: 'compiling', phase: 'text', initializedAt: new Date() },
    { status: 'queued', phase: 'text', initializedAt: new Date() },
    { status: 'queued', phase: 'image_merge', initializedAt: new Date() },
  ])('requests a follow-up for an initialized active run', (run) => {
    expect(decideSpaceRunRequest(run)).toBe('rerun_requested');
  });
});
