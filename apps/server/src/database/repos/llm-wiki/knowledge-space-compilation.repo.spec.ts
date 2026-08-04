import {
  decideSpaceRunRequest,
  reconcileFollowUpTargetScope,
  reconcileRunTargetScope,
} from './knowledge-space-compilation.repo';

describe('reconcileRunTargetScope', () => {
  it('leaves a full-Space Run unchanged for any request', () => {
    expect(
      reconcileRunTargetScope({
        runTargetSourcePageIds: null,
        requestTargetSourcePageIds: ['page-a'],
      }),
    ).toEqual({ changed: false, targetSourcePageIds: null });
  });

  it('widens a page-scoped Run to full-Space for a full request', () => {
    expect(
      reconcileRunTargetScope({
        runTargetSourcePageIds: ['page-a'],
        requestTargetSourcePageIds: undefined,
      }),
    ).toEqual({ changed: true, targetSourcePageIds: null });
  });

  it('unions two page-scoped inputs and flags the change', () => {
    expect(
      reconcileRunTargetScope({
        runTargetSourcePageIds: ['page-a'],
        requestTargetSourcePageIds: ['page-a', 'page-b'],
      }),
    ).toEqual({ changed: true, targetSourcePageIds: ['page-a', 'page-b'] });
  });

  it('reports no change when the request adds no new pages', () => {
    expect(
      reconcileRunTargetScope({
        runTargetSourcePageIds: ['page-a', 'page-b'],
        requestTargetSourcePageIds: ['page-a'],
      }),
    ).toEqual({ changed: false, targetSourcePageIds: ['page-a', 'page-b'] });
  });
});

describe('reconcileFollowUpTargetScope', () => {
  it('narrows the first post-initialization edit after a full Run to that page', () => {
    expect(
      reconcileFollowUpTargetScope({
        runTargetSourcePageIds: null,
        requestTargetSourcePageIds: ['page-a'],
        rerunAlreadyRequested: false,
      }),
    ).toEqual({ changed: true, targetSourcePageIds: ['page-a'] });
  });

  it('does not narrow an already requested full-Space follow-up', () => {
    expect(
      reconcileFollowUpTargetScope({
        runTargetSourcePageIds: null,
        requestTargetSourcePageIds: ['page-a'],
        rerunAlreadyRequested: true,
      }),
    ).toEqual({ changed: false, targetSourcePageIds: null });
  });
});

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
