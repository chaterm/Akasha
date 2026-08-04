import {
  buildSpaceSliceJobId,
  runPhaseToJobPhase,
  SpaceExecutionLease,
} from './knowledge-space-execution.repo';

describe('knowledge space execution contract', () => {
  it.each([
    ['text', 'text'],
    ['initial_aggregate', 'text'],
    ['image_merge', 'image_merge'],
    ['final_aggregate', 'image_merge'],
  ] as const)(
    'maps business phase %s to physical phase %s',
    (phase, jobPhase) => {
      expect(runPhaseToJobPhase(phase)).toBe(jobPhase);
    },
  );

  it('uses deterministic BullMQ-safe slice IDs', () => {
    expect(buildSpaceSliceJobId('run-1', 'text', 3)).toBe(
      'knowledge-space-text__run-1__text__3',
    );
    expect(buildSpaceSliceJobId('run-1', 'image_merge', 4)).toBe(
      'knowledge-space-image-merge__run-1__image_merge__4',
    );
    expect(buildSpaceSliceJobId('run-1', 'text', 3)).not.toContain(':');
  });

  it('requires a complete lease identity at compile time and runtime', () => {
    const lease: SpaceExecutionLease = {
      runId: 'run-1',
      knowledgeGeneration: 2,
      jobPhase: 'text',
      spaceJobSequence: 3,
      spaceJobId: 'job-3',
      executionToken: 'token-3',
    };
    expect(Object.keys(lease).sort()).toEqual([
      'executionToken',
      'jobPhase',
      'knowledgeGeneration',
      'runId',
      'spaceJobId',
      'spaceJobSequence',
    ]);
  });
});
