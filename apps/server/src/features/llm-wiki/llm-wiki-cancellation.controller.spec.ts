import { ForbiddenException } from '@nestjs/common';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { UserRole } from '../../common/helpers/types/permission';
import { LlmWikiController } from './llm-wiki.controller';

describe('LlmWikiController Run cancellation', () => {
  it('cancels one exact workspace Run and audits the committed transition', async () => {
    const fixture = createFixture();
    fixture.spaceCompilation.cancelRun.mockResolvedValue({
      disposition: 'cancelled',
      runId: RUN_ID,
      spaceId: 'space-1',
      status: 'cancelled',
      phase: 'complete',
      previousStatus: 'compiling',
      previousPhase: 'images',
      removedJobCount: 4,
      fencedActiveJobCount: 1,
      cleanupErrorCount: 0,
    });

    await expect(
      fixture.controller.cancelKnowledgeCompilationRun(
        RUN_ID,
        { reason: '  Test has completed.  ' },
        { role: UserRole.ADMIN } as never,
        { id: 'workspace-1' } as never,
      ),
    ).resolves.toEqual(expect.objectContaining({ disposition: 'cancelled' }));
    expect(fixture.spaceCompilation.cancelRun).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      runId: RUN_ID,
      reason: 'Test has completed.',
    });
    expect(fixture.auditService.log).toHaveBeenCalledWith({
      event: AuditEvent.KNOWLEDGE_COMPILE_CANCELLED,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: RUN_ID,
      spaceId: 'space-1',
      metadata: {
        runId: RUN_ID,
        previousStatus: 'compiling',
        previousPhase: 'images',
        reason: 'Test has completed.',
        removedJobCount: 4,
        fencedActiveJobCount: 1,
        cleanupErrorCount: 0,
      },
    });
  });

  it('does not create duplicate audit events for an idempotent terminal response', async () => {
    const fixture = createFixture();
    fixture.spaceCompilation.cancelRun.mockResolvedValue({
      disposition: 'already_terminal',
      runId: RUN_ID,
      spaceId: 'space-1',
      status: 'cancelled',
      phase: 'complete',
      removedJobCount: 0,
      fencedActiveJobCount: 0,
      cleanupErrorCount: 0,
    });

    await fixture.controller.cancelKnowledgeCompilationRun(
      RUN_ID,
      {},
      { role: UserRole.OWNER } as never,
      { id: 'workspace-1' } as never,
    );
    expect(fixture.auditService.log).not.toHaveBeenCalled();
  });

  it('rejects members before touching the Run', async () => {
    const fixture = createFixture();
    await expect(
      fixture.controller.cancelKnowledgeCompilationRun(
        RUN_ID,
        {},
        { role: UserRole.MEMBER } as never,
        { id: 'workspace-1' } as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fixture.spaceCompilation.cancelRun).not.toHaveBeenCalled();
  });
});

const RUN_ID = '019fc5b4-0a7a-7560-8a79-cfc3b80e9fdc';

function createFixture() {
  const auditService = { log: jest.fn() };
  const spaceCompilation = { cancelRun: jest.fn() };
  const controller = Object.assign(Object.create(LlmWikiController.prototype), {
    chatService: { isEnabledForWorkspace: jest.fn().mockReturnValue(true) },
    auditService,
    spaceCompilation,
  }) as LlmWikiController;
  return { controller, auditService, spaceCompilation };
}
