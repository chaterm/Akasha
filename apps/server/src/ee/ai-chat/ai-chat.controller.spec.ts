import { AiChatController } from './ai-chat.controller';
import { AiChatService } from './ai-chat.service';

describe('AiChatController', () => {
  it('streams a new knowledge-backed chat response and persists messages through the service', async () => {
    const service = {
      sendMessage: jest.fn().mockResolvedValue({
        chatId: 'chat-1',
        assistantMessageId: 'message-assistant-1',
        answer: 'Chaterm 企业版软件的登记批准日期是2026年06月05日。',
        citations: [{ sourcePageId: 'page-1', title: 'Chaterm', url: '/p/1' }],
        citationEvidence: [
          {
            sourcePageId: 'page-1',
            title: 'Chaterm',
            url: '/p/1',
            excerpts: [
              {
                text: '登记批准日期是2026年06月05日。',
                sourceRange: { startOffset: 0, endOffset: 19 },
                quoteHash: 'sha256:verified',
              },
            ],
          },
        ],
        retrievedSources: [
          { sourcePageId: 'page-1', title: 'Chaterm', url: '/p/1' },
        ],
        retrievalReasons: ['lexical'],
        completenessNotice: 'notice',
        answerMode: 'knowledge',
      }),
    };
    const controller = new AiChatController(
      service as unknown as AiChatService,
    );
    const response = mockSseResponse();

    await controller.send(
      {
        content: 'chaterm 登记批准日期',
        spaceIds: ['space-1'],
      },
      user() as never,
      workspace() as never,
      response as never,
    );

    expect(service.sendMessage).toHaveBeenCalledWith({
      workspace: workspace(),
      user: user(),
      chatId: undefined,
      content: 'chaterm 登记批准日期',
      mentionedPageIds: undefined,
      contextPageId: undefined,
      attachmentIds: undefined,
      spaceIds: ['space-1'],
      onEvent: expect.any(Function),
    });
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/event-stream',
    );
    expect(response.write.mock.calls.map(([payload]) => payload)).toEqual([
      'data: {"type":"chat_created","chatId":"chat-1"}\n\n',
      'data: {"type":"content","text":"Chaterm 企业版软件的登记批准日期是2026年06月05日。"}\n\n',
      'data: {"type":"done","messageId":"message-assistant-1","citations":[{"sourcePageId":"page-1","title":"Chaterm","url":"/p/1"}],"citationEvidence":[{"sourcePageId":"page-1","title":"Chaterm","url":"/p/1","excerpts":[{"text":"登记批准日期是2026年06月05日。","sourceRange":{"startOffset":0,"endOffset":19},"quoteHash":"sha256:verified"}]}],"retrievedSources":[{"sourcePageId":"page-1","title":"Chaterm","url":"/p/1"}],"retrievalReasons":["lexical"],"completenessNotice":"notice","answerMode":"knowledge"}\n\n',
      'data: [DONE]\n\n',
    ]);
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it('streams through Fastify raw response when Nest uses the Fastify adapter', async () => {
    const service = {
      sendMessage: jest.fn().mockResolvedValue({
        chatId: 'chat-1',
        assistantMessageId: 'message-assistant-1',
        answer: 'answer',
      }),
    };
    const controller = new AiChatController(
      service as unknown as AiChatService,
    );
    const reply = mockFastifyReply();

    await controller.send(
      { content: 'hello' },
      user() as never,
      workspace() as never,
      reply as never,
    );

    expect(reply.raw.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/event-stream',
    );
    expect(reply.raw.write.mock.calls.map(([payload]) => payload)).toEqual([
      'data: {"type":"chat_created","chatId":"chat-1"}\n\n',
      'data: {"type":"content","text":"answer"}\n\n',
      'data: {"type":"done","messageId":"message-assistant-1"}\n\n',
      'data: [DONE]\n\n',
    ]);
    expect(reply.raw.end).toHaveBeenCalledTimes(1);
  });
});

function mockSseResponse() {
  return {
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
  };
}

function mockFastifyReply() {
  return {
    raw: mockSseResponse(),
  };
}

function workspace() {
  return {
    id: 'workspace-1',
    settings: { ai: { chat: true } },
  };
}

function user() {
  return {
    id: 'user-1',
    workspaceId: 'workspace-1',
    role: 'owner',
  };
}
