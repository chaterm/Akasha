import { AiChatService } from './ai-chat.service';
import { AiChatRepo } from '@akasha/db/repos/ai-chat/ai-chat.repo';
import { SpaceRepo } from '@akasha/db/repos/space/space.repo';
import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import { AiKnowledgeChatService } from '../llm-wiki/services/ai-knowledge-chat.service';

describe('AiChatService', () => {
  it('creates a chat, stores both messages, and answers with all workspace spaces for owners', async () => {
    const repo = {
      createChat: jest.fn().mockResolvedValue(chat('chat-1')),
      addMessage: jest
        .fn()
        .mockResolvedValueOnce(message('message-user-1', 'user', 'hello'))
        .mockResolvedValueOnce(
          message('message-assistant-1', 'assistant', 'answer'),
        ),
      findMessages: jest.fn(),
    };
    const spaceRepo = {
      getSpacesInWorkspace: jest.fn().mockResolvedValue({
        items: [{ id: 'space-1' }, { id: 'space-2' }],
      }),
    };
    const spaceMemberRepo = {
      getUserSpaceIds: jest.fn(),
    };
    const knowledgeChat = {
      chat: jest.fn().mockResolvedValue({
        answer: 'answer',
        citations: [
          { sourcePageId: 'page-1', title: 'Page', url: '/p/page-1' },
        ],
        completenessNotice: 'notice',
      }),
    };
    const service = new AiChatService(
      repo as unknown as AiChatRepo,
      spaceRepo as unknown as SpaceRepo,
      spaceMemberRepo as unknown as SpaceMemberRepo,
      knowledgeChat as unknown as AiKnowledgeChatService,
    );

    await expect(
      service.sendMessage({
        workspace: workspace() as never,
        user: user('owner') as never,
        content: 'hello',
      }),
    ).resolves.toEqual({
      chatId: 'chat-1',
      assistantMessageId: 'message-assistant-1',
      answer: 'answer',
      citations: [{ sourcePageId: 'page-1', title: 'Page', url: '/p/page-1' }],
      retrievalDiagnostics: undefined,
    });

    expect(repo.createChat).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      creatorId: 'user-1',
      title: 'hello',
    });
    expect(knowledgeChat.chat).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'hello',
      spaceIds: ['space-1', 'space-2'],
      chatContext: [],
      workspace: workspace(),
      mentionedPageIds: undefined,
      contextPageId: undefined,
      attachmentIds: undefined,
      onToken: expect.any(Function),
      onStage: expect.any(Function),
    });
    expect(repo.addMessage).toHaveBeenNthCalledWith(1, {
      workspaceId: 'workspace-1',
      chatId: 'chat-1',
      userId: 'user-1',
      role: 'user',
      content: 'hello',
      toolCalls: null,
      metadata: null,
    });
    expect(repo.addMessage).toHaveBeenNthCalledWith(2, {
      workspaceId: 'workspace-1',
      chatId: 'chat-1',
      userId: null,
      role: 'assistant',
      content: 'answer',
      toolCalls: null,
      metadata: {
        citations: [
          { sourcePageId: 'page-1', title: 'Page', url: '/p/page-1' },
        ],
        completenessNotice: 'notice',
      },
    });
    expect(spaceMemberRepo.getUserSpaceIds).not.toHaveBeenCalled();
  });
});

function workspace() {
  return {
    id: 'workspace-1',
    settings: { ai: { chat: true } },
  };
}

function user(role: string) {
  return {
    id: 'user-1',
    workspaceId: 'workspace-1',
    role,
  };
}

function chat(id: string) {
  return {
    id,
    workspaceId: 'workspace-1',
    creatorId: 'user-1',
    title: 'hello',
    createdAt: new Date('2026-06-17T00:00:00.000Z'),
    updatedAt: new Date('2026-06-17T00:00:00.000Z'),
    deletedAt: null,
  };
}

function message(id: string, role: string, content: string) {
  return {
    id,
    chatId: 'chat-1',
    workspaceId: 'workspace-1',
    userId: role === 'user' ? 'user-1' : null,
    role,
    content,
    toolCalls: null,
    metadata: null,
    createdAt: new Date('2026-06-17T00:00:00.000Z'),
    updatedAt: new Date('2026-06-17T00:00:00.000Z'),
    deletedAt: null,
  };
}
