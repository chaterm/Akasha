import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import {
  McpToolContext,
  McpToolExtension,
  McpToolRegistry,
} from '../../../core/mcp/mcp-tool-registry';
import {
  AiKnowledgeChatService,
  isGeneralKnowledgeEnabledForUser,
} from './ai-knowledge-chat.service';
import { SpaceService } from '../../../core/space/services/space.service';
import { SpaceMemberService } from '../../../core/space/services/space-member.service';
import { UserRole } from '../../../common/helpers/types/permission';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { KnowledgeQueryAuditRepo } from '@akasha/db/repos/llm-wiki/knowledge-query-audit.repo';

/** Registers the EE knowledge query as an MCP tool when the EE module is loaded. */
@Injectable()
export class KnowledgeMcpToolExtension
  implements OnModuleInit, McpToolExtension
{
  constructor(
    private readonly registry: McpToolRegistry,
    private readonly chatService: AiKnowledgeChatService,
    private readonly spaceService: SpaceService,
    private readonly spaceMemberService: SpaceMemberService,
    private readonly queryAuditRepo: KnowledgeQueryAuditRepo,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  register(
    server: McpServer,
    context: McpToolContext,
    runTool: (fn: () => Promise<unknown>) => Promise<{
      content: Array<{ type: 'text'; text: string }>;
      isError?: boolean;
    }>,
  ): void {
    server.registerTool(
      'query_knowledge',
      {
        title: 'Query Akasha knowledge',
        description:
          'Search the Akasha knowledge base containing company and personal knowledge. Use it when an answer may need information outside general model knowledge; clearly stable general knowledge and simple calculations do not require a search.',
        inputSchema: {
          query: z
            .string()
            .min(1)
            .max(4000)
            .describe('A focused question or retrieval query for the knowledge base.'),
          spaceIds: z
            .array(z.string().uuid())
            .max(100)
            .optional()
            .describe(
              'Optional accessible space UUIDs; omit to search all spaces allowed by ACL.',
            ),
          chatContext: z
            .array(z.string().max(4000))
            .max(30)
            .optional()
            .describe(
              'Optional prior conversation context, supplied only when it changes the query meaning.',
            ),
        },
      },
      (args) => runTool(() => this.query(context, args)),
    );
  }

  private async query(
    context: McpToolContext,
    args: { query: string; spaceIds?: string[]; chatContext?: string[] },
  ) {
    const spaceIds = await this.resolveSpaceIds(context, args.spaceIds);
    const result = await this.chatService.chat({
      workspaceId: context.workspace.id,
      userId: context.user.id,
      query: args.query,
      spaceIds,
      chatContext: args.chatContext,
      workspace: context.workspace,
      ...(isGeneralKnowledgeEnabledForUser(context.user)
        ? {}
        : { generalKnowledgeEnabled: false }),
    });

    const diagnostics = result.retrievalDiagnostics;
    const scope = result.retrievalScope;
    const queryHash = createHash('sha256').update(args.query).digest('hex');
    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_QUERY,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: context.workspace.id,
      metadata: {
        origin: 'mcp_query_knowledge',
        spaceIds,
        requestedSpaceIds: scope?.requestedSpaceIds ?? spaceIds,
        effectiveSpaceIds: scope?.effectiveSpaceIds ?? [],
        citationCount: result.citations.length,
      },
    });
    await this.queryAuditRepo.recordQuery({
      workspaceId: context.workspace.id,
      userId: context.user.id,
      queryHash,
      retrievalMode: diagnostics?.mode ?? result.answerMode,
      authorizedCapsuleCount: diagnostics?.authorizedChunkCount ?? 0,
      metadata: {
        origin: 'mcp_query_knowledge',
        spaceIds,
        requestedSpaceIds: scope?.requestedSpaceIds ?? spaceIds,
        effectiveSpaceIds: scope?.effectiveSpaceIds ?? [],
        answerMode: result.answerMode,
        citationCount: result.citations.length,
        retrievedSourceCount: result.retrievedSources.length,
        queryEmbeddingAvailable: diagnostics?.queryEmbeddingAvailable ?? false,
        candidateSourceCount: diagnostics?.candidateSourceCount ?? 0,
        policyCandidateSourceCount:
          diagnostics?.policyCandidateSourceCount ?? 0,
        fallbackCandidateSourceCount:
          diagnostics?.fallbackCandidateSourceCount ?? 0,
        finalAuthorizedSourceCount:
          diagnostics?.finalAuthorizedSourceCount ?? 0,
        accessPolicyFallbackUsed:
          diagnostics?.accessPolicyFallbackUsed ?? false,
        candidateChunkCount: diagnostics?.candidateChunkCount ?? 0,
        rankedCandidateCount: diagnostics?.rankedCandidateCount ?? 0,
        authorizedChunkCount: diagnostics?.authorizedChunkCount ?? 0,
        filteredChunkCount: diagnostics?.filteredChunkCount ?? 0,
      },
    });

    // Keep MCP responses small and stable. Detailed retrieval diagnostics and
    // snippets remain available through the HTTP knowledge API when needed.
    return {
      answer: result.answer,
      answerMode: result.answerMode,
      retrievalQuery: result.retrievalQuery,
      citations: result.citations.slice(0, 20),
      citationEvidence: result.citationEvidence.slice(0, 8).map((evidence) => ({
        ...evidence,
        excerpts: evidence.excerpts.slice(0, 3).map((excerpt) => ({
          ...excerpt,
          text: excerpt.text.slice(0, 1200),
        })),
      })),
      citationEvidenceTruncated:
        result.citationEvidence.length > 8 ||
        result.citationEvidence.some((evidence) =>
          evidence.excerpts.some((excerpt) => excerpt.text.length > 1200),
        ),
      warnings: result.warnings,
      completenessNotice: result.completenessNotice,
    };
  }

  private async resolveSpaceIds(
    context: McpToolContext,
    requested?: string[],
  ): Promise<string[]> {
    if (requested?.length) return requested;

    const spaceIds: string[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    while (true) {
      const result =
        context.user.role === UserRole.OWNER
          ? await this.spaceService.getWorkspaceSpaces(context.workspace.id, {
              limit: 100,
              cursor,
              query: '',
              adminView: false,
            })
          : await this.spaceMemberService.getUserSpaces(context.user.id, {
              limit: 100,
              cursor,
              query: '',
              adminView: false,
            });
      spaceIds.push(...result.items.map((space) => space.id));
      if (!result.meta.hasNextPage) return spaceIds;
      const nextCursor = result.meta.nextCursor;
      if (!nextCursor || seenCursors.has(nextCursor)) return spaceIds;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }
}
