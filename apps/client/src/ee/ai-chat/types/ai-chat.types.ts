export type AiChat = {
  id: string;
  workspaceId: string;
  creatorId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiChatToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
};

export type AiChatMessage = {
  id: string;
  chatId: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  toolCalls: AiChatToolCall[] | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type AiQaProgressStage =
  | "permissions"
  | "understanding"
  | "retrieval"
  | "generation";

export type AiChatThinkingStep =
  | "understanding"
  | "searching"
  | "analyzing"
  | "preparing"
  | "fallback";

export type AiChatThinkingStatus =
  | "started"
  | "completed"
  | "skipped"
  | "failed";

export type AiChatThinkingStats = {
  historyMessageCount?: number;
  queryRewritten?: boolean;
  matchedChunkCount?: number;
  sourceCount?: number;
  includedItemCount?: number;
};

export type AiChatThinkingEvent = {
  step: AiChatThinkingStep;
  status: AiChatThinkingStatus;
  durationMs?: number;
  stats?: AiChatThinkingStats;
  outcome?: "knowledge" | "insufficient" | "general";
};

export type AiChatThinkingItem = AiChatThinkingEvent & {
  startedAt?: number;
};

export type AiQaCitation = {
  sourcePageId: string;
  title: string;
  url: string;
};

export type AiQaCitationEvidence = AiQaCitation & {
  excerpts: Array<{
    text: string;
    sourceRange: {
      startOffset: number;
      endOffset: number;
    };
    quoteHash: string;
  }>;
};

export type AiQaRetrievalDiagnostics = {
  mode: string;
  queryEmbeddingAvailable: boolean;
  candidateSourceCount: number;
  policyCandidateSourceCount: number;
  fallbackCandidateSourceCount: number;
  finalAuthorizedSourceCount: number;
  accessPolicyFallbackUsed: boolean;
  candidateChunkCount: number;
  rankedCandidateCount: number;
  authorizedChunkCount: number;
  filteredChunkCount: number;
};

export type AiChatStreamEvent =
  | { type: "chat_created"; chatId: string }
  | {
      type: "message_edited";
      chatId: string;
      messageId: string;
      content: string;
    }
  | { type: "progress"; stage: AiQaProgressStage }
  | ({ type: "thinking" } & AiChatThinkingEvent)
  | { type: "content"; text: string }
  | { type: "superseded"; chatId: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      args: Record<string, unknown>;
    }
  | { type: "tool_result"; id: string; result: unknown }
  | {
      type: "done";
      messageId: string;
      userMessageId?: string;
      usage?: Record<string, number>;
      citations?: AiQaCitation[];
      citationEvidence?: AiQaCitationEvidence[];
      retrievedSources?: AiQaCitation[];
      retrievalDiagnostics?: AiQaRetrievalDiagnostics;
      retrievalReasons?: string[];
      completenessNotice?: string;
      answerMode?: "knowledge" | "no_match" | "general";
      retrievalQuery?: string;
      canExpandScope?: boolean;
      thinkingTrace?: AiChatThinkingEvent[];
    }
  | { type: "error"; message: string; code?: string; retryable?: boolean };

export type PageMention = {
  id: string;
  title: string;
  slugId: string;
  spaceSlug?: string;
  icon?: string;
};

export type ChatAttachment = {
  id: string;
  fileName: string;
  fileExt: string;
  fileSize: number;
  mimeType: string;
};
