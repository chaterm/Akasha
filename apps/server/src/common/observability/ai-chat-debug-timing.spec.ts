import { AiChatDebugTiming } from './ai-chat-debug-timing';

describe('AiChatDebugTiming', () => {
  const originalDebugMode = process.env.DEBUG_MODE;

  afterEach(() => {
    if (originalDebugMode === undefined) {
      delete process.env.DEBUG_MODE;
    } else {
      process.env.DEBUG_MODE = originalDebugMode;
    }
  });

  it('does not create a trace when debug mode is disabled', () => {
    process.env.DEBUG_MODE = 'false';
    const logger = { debug: jest.fn() };

    expect(
      AiChatDebugTiming.create(logger, {
        workspaceId: 'workspace-1',
        operation: 'send',
      }),
    ).toBeUndefined();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('writes correlated structured phase and summary logs in debug mode', async () => {
    process.env.DEBUG_MODE = 'true';
    const logger = { debug: jest.fn() };
    const timing = AiChatDebugTiming.create(logger, {
      workspaceId: 'workspace-1',
      operation: 'send',
    })!;

    timing.setChatId('chat-1');
    await timing.measure('retrieval.embedding', async () => [0.1, 0.2], {
      provider: 'configured',
    });
    timing.markFirstContent({ source: 'model' });
    timing.complete({ answerMode: 'knowledge' });

    const events = logger.debug.mock.calls.map(([event]) => event);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'ai_chat_timing',
          phase: 'request.started',
          workspaceId: 'workspace-1',
          operation: 'send',
        }),
        expect.objectContaining({
          event: 'ai_chat_timing',
          phase: 'retrieval.embedding',
          chatId: 'chat-1',
          durationMs: expect.any(Number),
          provider: 'configured',
        }),
        expect.objectContaining({
          event: 'ai_chat_timing',
          phase: 'response.first_content',
          timeToFirstContentMs: expect.any(Number),
        }),
        expect.objectContaining({
          event: 'ai_chat_timing',
          phase: 'request.total',
          durationMs: expect.any(Number),
          phaseDurationsMs: expect.objectContaining({
            'retrieval.embedding': expect.any(Number),
          }),
          answerMode: 'knowledge',
        }),
      ]),
    );
    expect(new Set(events.map((event) => event.traceId)).size).toBe(1);
  });
});
