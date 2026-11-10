import { ForbiddenException } from '@nestjs/common';
import { Workspace } from '@akasha/db/types/entity.types';
import {
  EditorAiController,
  isGenerativeAiEnabledForWorkspace,
} from './editor-ai.controller';
import { EditorAiService } from './editor-ai.service';

describe('EditorAiController', () => {
  it('streams chunks using the SSE contract expected by the editor', async () => {
    const service = {
      stream: jest.fn().mockReturnValue(
        (async function* () {
          yield 'Improved';
          yield ' text';
        })(),
      ),
    };
    const controller = new EditorAiController(
      service as unknown as EditorAiService,
    );
    const response = mockSseResponse();

    await controller.stream(
      { action: 'improve_writing', content: 'Original text' },
      workspace(true),
      response as never,
    );

    expect(service.stream).toHaveBeenCalledWith(
      {
        action: 'improve_writing',
        content: 'Original text',
      },
      { abortSignal: expect.any(AbortSignal) },
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/event-stream',
    );
    expect(response.write.mock.calls.map(([payload]) => payload)).toEqual([
      'data: {"content":"Improved"}\n\n',
      'data: {"content":" text"}\n\n',
      'data: [DONE]\n\n',
    ]);
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it('rejects generation when the workspace feature is disabled', async () => {
    const service = { generate: jest.fn() };
    const controller = new EditorAiController(
      service as unknown as EditorAiService,
    );

    await expect(
      controller.generate(
        { action: 'summarize', content: 'Source' },
        workspace(false),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.generate).not.toHaveBeenCalled();
  });

  it('aborts model streaming when the client disconnects', async () => {
    let receivedSignal: AbortSignal | undefined;
    let closeListener: (() => void) | undefined;
    const service = {
      stream: jest.fn().mockImplementation((_dto, options) => {
        receivedSignal = options.abortSignal;
        return (async function* () {
          closeListener?.();
          receivedSignal?.throwIfAborted();
          yield 'never';
        })();
      }),
    };
    const controller = new EditorAiController(
      service as unknown as EditorAiService,
    );
    const response = {
      ...mockSseResponse(),
      once: jest.fn((_event, listener) => {
        closeListener = listener;
      }),
      off: jest.fn(),
      destroyed: true,
    };

    await controller.stream(
      { action: 'summarize', content: 'Source' },
      workspace(true),
      response as never,
    );

    expect(receivedSignal?.aborted).toBe(true);
    expect(response.write).not.toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
  });
});

describe('isGenerativeAiEnabledForWorkspace', () => {
  it('only enables editor AI for an explicit generative setting', () => {
    expect(isGenerativeAiEnabledForWorkspace(workspace(true))).toBe(true);
    expect(isGenerativeAiEnabledForWorkspace(workspace(false))).toBe(false);
    expect(
      isGenerativeAiEnabledForWorkspace({ settings: null } as Workspace),
    ).toBe(false);
  });
});

function workspace(generative: boolean): Workspace {
  return { settings: { ai: { generative } } } as unknown as Workspace;
}

function mockSseResponse() {
  return {
    setHeader: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    flushHeaders: jest.fn(),
  };
}
