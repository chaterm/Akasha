import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { UserRole } from '../../common/helpers/types/permission';
import { IsElfLlmWikiController } from './iself-llm-wiki.controller';

describe('IsElfLlmWikiController', () => {
  it('uses the same chat response pipeline as the regular knowledge query', async () => {
    const chatService = {
      isEnabledForWorkspace: jest.fn().mockReturnValue(true),
      chat: jest.fn().mockResolvedValue({
        answer: 'Kafka is used for async events.',
        answerMode: 'knowledge',
        citations: [
          { sourcePageId: 'page-1', title: 'Kafka', url: '/p/page-1' },
        ],
        citationEvidence: [
          {
            sourcePageId: 'page-1',
            title: 'Kafka',
            url: '/p/page-1',
            excerpts: [],
          },
        ],
        retrievedSources: [
          { sourcePageId: 'page-1', title: 'Kafka', url: '/p/page-1' },
        ],
        snippets: [
          {
            id: 'chunk-1',
            title: 'Kafka',
            text: 'Use Kafka for async events.',
            retrievalReasons: ['lexical'],
            sourceWindows: [],
          },
        ],
        warnings: [],
        retrievalReasons: ['lexical'],
        budget: {},
        completenessNotice:
          'Some knowledge may be unavailable because access is permission-scoped.',
        retrievalDiagnostics: {
          mode: 'high_completeness',
          queryEmbeddingAvailable: false,
          candidateSourceCount: 1,
          policyCandidateSourceCount: 1,
          fallbackCandidateSourceCount: 0,
          finalAuthorizedSourceCount: 1,
          accessPolicyFallbackUsed: false,
          candidateChunkCount: 1,
          rankedCandidateCount: 1,
          authorizedChunkCount: 1,
          filteredChunkCount: 0,
        },
        retrievalScope: {
          requestedSpaceIds: ['space-1'],
          effectiveSpaceIds: ['space-1'],
        },
      }),
    };
    const citationImageResolver = {
      resolveImagesForCitations: jest.fn().mockResolvedValue([
        {
          sourcePageId: 'page-1',
          title: 'Kafka',
          url: '/p/page-1',
          images: [],
        },
      ]),
    };
    const queryAuditRepo = {
      recordQuery: jest.fn().mockResolvedValue(undefined),
    };
    const auditService = { log: jest.fn() };
    const apiKeyService = {
      validatePublicApiKey: jest.fn().mockResolvedValue({
        apiKeyId: 'public-key-1',
        spaceIds: ['space-1'],
      }),
    };
    const environmentService = {
      getAppUrl: jest.fn().mockReturnValue('https://akasha.example.com'),
    };
    const attachmentResolver = {
      resolveAttachments: jest.fn().mockResolvedValue([
        {
          attachmentId: 'attachment-1',
          sourcePageId: 'page-1',
          fileName: 'design.pdf',
          mimeType: 'application/pdf',
          fileSize: 42,
          url: 'https://akasha.example.com/api/files/public/attachment-1/design.pdf?jwt=jwt-1',
        },
      ]),
    };
    const controller = new IsElfLlmWikiController(
      chatService as any,
      citationImageResolver as any,
      queryAuditRepo as any,
      apiKeyService as any,
      auditService as any,
      environmentService as any,
      attachmentResolver as any,
    );
    const user = {
      id: 'user-1',
      workspaceId: 'workspace-1',
      role: UserRole.MEMBER,
      // iself must remain fail-closed even if the user's UI preference is on.
      settings: { preferences: { generalKnowledge: true } },
    } as any;
    const workspace = {
      id: 'workspace-1',
      settings: { ai: { chat: true } },
    } as any;

    await expect(
      controller.queryKnowledge(
        {
          query: 'How do we use Kafka?',
          spaceIds: ['space-1'],
          chatContext: ['Previous turn'],
        },
        user,
        workspace,
        'public-token',
      ),
    ).resolves.toEqual({
      answer: 'Kafka is used for async events.',
      answerMode: 'knowledge',
      citations: [
        {
          sourcePageId: 'page-1',
          title: 'Kafka',
          url: 'https://akasha.example.com/p/page-1',
          images: [],
        },
      ],
      citationEvidence: [
        {
          sourcePageId: 'page-1',
          title: 'Kafka',
          url: 'https://akasha.example.com/p/page-1',
          excerpts: [],
        },
      ],
      retrievedSources: [
        {
          sourcePageId: 'page-1',
          title: 'Kafka',
          url: 'https://akasha.example.com/p/page-1',
        },
      ],
      snippets: [
        {
          id: 'chunk-1',
          title: 'Kafka',
          text: 'Use Kafka for async events.',
          retrievalReasons: ['lexical'],
          sourceWindows: [],
        },
      ],
      warnings: [],
      retrievalReasons: ['lexical'],
      budget: {},
      completenessNotice:
        'Some knowledge may be unavailable because access is permission-scoped.',
    });

    expect(chatService.chat).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'How do we use Kafka?',
      spaceIds: ['space-1'],
      chatContext: ['Previous turn'],
      workspace,
      generalKnowledgeEnabled: false,
    });
    expect(citationImageResolver.resolveImagesForCitations).toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: AuditEvent.KNOWLEDGE_QUERY,
        resourceType: AuditResource.KNOWLEDGE,
        metadata: expect.objectContaining({
          origin: 'iself_knowledge_query',
          publicApiKeyId: 'public-key-1',
        }),
      }),
    );
    expect(queryAuditRepo.recordQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        retrievalMode: 'high_completeness',
        metadata: expect.objectContaining({ origin: 'iself_knowledge_query' }),
      }),
    );
    expect(attachmentResolver.resolveAttachments).not.toHaveBeenCalled();

    const withAttachments = await controller.queryKnowledge(
      {
        query: 'How do we use Kafka?',
        spaceIds: ['space-1'],
        attachments: true,
        generalKnowledgeEnabled: true,
        scoreThreshold: 0.6,
      },
      user,
      workspace,
      'public-token',
    );
    expect(withAttachments.attachments).toEqual([
      expect.objectContaining({
        attachmentId: 'attachment-1',
        sourcePageId: 'page-1',
        fileName: 'design.pdf',
      }),
    ]);
    expect(attachmentResolver.resolveAttachments).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      citations: [{ sourcePageId: 'page-1', title: 'Kafka', url: '/p/page-1' }],
    });
    expect(chatService.chat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        generalKnowledgeEnabled: true,
        scoreThreshold: 0.6,
      }),
    );

    await controller.queryKnowledge(
      {
        query: 'How do we use Kafka?',
        spaceIds: ['space-1'],
        includeCitations: true,
      },
      user,
      workspace,
      'public-token',
    );
    expect(attachmentResolver.resolveAttachments).toHaveBeenLastCalledWith({
      workspaceId: 'workspace-1',
      citations: [{ sourcePageId: 'page-1', title: 'Kafka', url: '/p/page-1' }],
    });
  });
});
