import { useState, useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  editChatMessage,
  getChatInfo,
  sendChatMessage,
} from "../services/ai-chat-service";
import type {
  AiChatMessage,
  AiChatStreamEvent,
  AiChatThinkingItem,
  AiChatToolCall,
  AiQaProgressStage,
  ChatAttachment,
  PageMention,
} from "../types/ai-chat.types";

type ChatStreamOptions = {
  onChatCreated?: (chatId: string) => void;
};

type ChatStreamSession = {
  chatId: string | undefined;
  messages: AiChatMessage[];
  streamingContent: string;
  streamingToolCalls: AiChatToolCall[];
  isStreaming: boolean;
  progressStage: AiQaProgressStage | null;
  thinkingSteps: AiChatThinkingItem[];
  error: string | null;
  errorCode: string | null;
  isRetryable: boolean;
  hydrated: boolean;
  abortController: AbortController | null;
};

const NEW_CHAT_SESSION_KEY = "__new__";

function chatSessionKey(chatId: string | undefined): string {
  return chatId || NEW_CHAT_SESSION_KEY;
}

function createChatStreamSession(
  chatId: string | undefined,
): ChatStreamSession {
  return {
    chatId,
    messages: [],
    streamingContent: "",
    streamingToolCalls: [],
    isStreaming: false,
    progressStage: null,
    thinkingSteps: [],
    error: null,
    errorCode: null,
    isRetryable: false,
    hydrated: false,
    abortController: null,
  };
}

export function useChatStream(
  chatId: string | undefined,
  options?: ChatStreamOptions,
) {
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingToolCalls, setStreamingToolCalls] = useState<
    AiChatToolCall[]
  >([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [progressStage, setProgressStage] = useState<AiQaProgressStage | null>(
    null,
  );
  const [thinkingSteps, setThinkingSteps] = useState<AiChatThinkingItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [isRetryable, setIsRetryable] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const currentChatIdRef = useRef(chatId);
  currentChatIdRef.current = chatId;
  const onChatCreatedRef = useRef(options?.onChatCreated);
  onChatCreatedRef.current = options?.onChatCreated;
  const sessionsRef = useRef(new Map<string, ChatStreamSession>());
  const activeSessionRef = useRef<ChatStreamSession | null>(null);

  const syncActiveSession = useCallback((session: ChatStreamSession) => {
    if (activeSessionRef.current !== session) return;
    setMessages(session.messages);
    setStreamingContent(session.streamingContent);
    setStreamingToolCalls(session.streamingToolCalls);
    setIsStreaming(session.isStreaming);
    setProgressStage(session.progressStage);
    setThinkingSteps(session.thinkingSteps);
    setError(session.error);
    setErrorCode(session.errorCode);
    setIsRetryable(session.isRetryable);
  }, []);

  // Switch the visible transcript without cancelling streams belonging to
  // other chats. Each session keeps its own optimistic and streaming state.
  useEffect(() => {
    const key = chatSessionKey(chatId);
    let session = sessionsRef.current.get(key);
    if (!session) {
      session = createChatStreamSession(chatId);
      sessionsRef.current.set(key, session);
    }
    activeSessionRef.current = session;
    abortRef.current = session.abortController;
    syncActiveSession(session);
  }, [chatId, syncActiveSession]);

  const hydrateFromServer = useCallback((msgs: AiChatMessage[]) => {
    const forId = currentChatIdRef.current;
    if (!forId) return;
    const session = sessionsRef.current.get(chatSessionKey(forId));
    if (!session || session.hydrated || session.isStreaming) return;
    session.hydrated = true;
    session.messages = msgs;
    syncActiveSession(session);
  }, [syncActiveSession]);

  const reconcileFromServer = useCallback(
    async (targetChatId: string) => {
      try {
        const info = await getChatInfo(targetChatId);
        queryClient.setQueryData(["ai-chat", targetChatId], info);
        const session = sessionsRef.current.get(chatSessionKey(targetChatId));
        if (!session || session.isStreaming) return;
        session.hydrated = true;
        session.messages = info.messages;
        syncActiveSession(session);
      } catch {
        queryClient.invalidateQueries({
          queryKey: ["ai-chat", targetChatId],
        });
      }
    },
    [queryClient, syncActiveSession],
  );

  const handleStreamEvent = useCallback(
    (event: AiChatStreamEvent, session: ChatStreamSession) => {
      switch (event.type) {
        case "chat_created":
          sessionsRef.current.delete(chatSessionKey(session.chatId));
          session.chatId = event.chatId;
          session.hydrated = true;
          sessionsRef.current.set(chatSessionKey(session.chatId), session);
          if (activeSessionRef.current === session) {
            currentChatIdRef.current = event.chatId;
            if (onChatCreatedRef.current) {
              onChatCreatedRef.current(event.chatId);
            } else {
              navigate(`/ai/chat/${event.chatId}`, { replace: true });
            }
          }
          queryClient.invalidateQueries({ queryKey: ["ai-chats"] });
          break;
        case "message_edited":
          const messageIndex = session.messages.findIndex(
            (message) => message.id === event.messageId,
          );
          if (messageIndex < 0) break;
          session.messages = session.messages
            .slice(0, messageIndex + 1)
            .map((message) =>
              message.id === event.messageId
                ? { ...message, content: event.content }
                : message,
            );
          syncActiveSession(session);
          break;
        case "content":
          session.streamingContent += event.text;
          syncActiveSession(session);
          break;
        case "progress":
          session.progressStage = event.stage;
          syncActiveSession(session);
          break;
        case "thinking":
          session.thinkingSteps = upsertThinkingStep(session.thinkingSteps, {
            step: event.step,
            status: event.status,
            durationMs: event.durationMs,
            stats: event.stats,
            outcome: event.outcome,
            ...(event.status === "started" ? { startedAt: Date.now() } : {}),
          });
          syncActiveSession(session);
          break;
        case "tool_call":
          session.streamingToolCalls = [
            ...session.streamingToolCalls,
            {
              id: event.id,
              name: event.name,
              args: event.args,
            },
          ];
          syncActiveSession(session);
          break;
        case "tool_result":
          session.streamingToolCalls = session.streamingToolCalls.map(
            (toolCall) =>
              toolCall.id === event.id
                ? { ...toolCall, result: event.result }
                : toolCall,
          );
          syncActiveSession(session);
          break;
        case "done": {
          const targetChatId = session.chatId || "";
          const wasActive = activeSessionRef.current === session;
          const assistantMessage: AiChatMessage = {
            id: event.messageId,
            chatId: targetChatId,
            role: "assistant",
            content: session.streamingContent || null,
            toolCalls: session.streamingToolCalls.length
              ? session.streamingToolCalls
              : null,
            metadata: buildAssistantMetadata(event),
            createdAt: new Date().toISOString(),
          };
          session.messages = [
            ...replaceOptimisticUserMessage(
              session.messages,
              event.userMessageId,
              targetChatId,
            ),
            assistantMessage,
          ];
          session.streamingContent = "";
          session.streamingToolCalls = [];
          session.isStreaming = false;
          session.progressStage = null;
          session.thinkingSteps = [];
          syncActiveSession(session);
          queryClient.invalidateQueries({
            queryKey: ["ai-chat", targetChatId],
          });
          queryClient.invalidateQueries({ queryKey: ["ai-chats"] });
          if (!wasActive && targetChatId) {
            void reconcileFromServer(targetChatId);
          }
          break;
        }
        case "superseded":
          session.streamingContent = "";
          session.streamingToolCalls = [];
          session.isStreaming = false;
          session.progressStage = null;
          session.thinkingSteps = [];
          syncActiveSession(session);
          void reconcileFromServer(event.chatId);
          break;
        case "error":
          session.error = event.message;
          session.errorCode = event.code || null;
          session.isRetryable = event.retryable || false;
          session.isStreaming = false;
          session.progressStage = null;
          session.thinkingSteps = [];
          syncActiveSession(session);
          break;
      }
    },
    [navigate, queryClient, reconcileFromServer, syncActiveSession],
  );

  const sendMessage = useCallback(
    (
      content: string,
      mentions: PageMention[] = [],
      attachments: ChatAttachment[] = [],
      contextPageId?: string,
      spaceIds?: string[],
      responseMode?: "knowledge" | "general",
    ) => {
      if (isStreaming || (!content.trim() && attachments.length === 0)) return;

      const session = activeSessionRef.current;
      if (!session) return;
      session.error = null;
      session.errorCode = null;
      session.isRetryable = false;
      session.hydrated = true;
      session.isStreaming = true;
      session.progressStage = "permissions";
      session.thinkingSteps = [
        {
          step: responseMode === "general" ? "preparing" : "understanding",
          status: "started",
          startedAt: Date.now(),
        },
      ];
      session.streamingContent = "";
      session.streamingToolCalls = [];

      const metadata: Record<string, unknown> = {};
      if (mentions.length) {
        metadata.mentionedPageIds = mentions.map((m) => m.id);
      }
      if (attachments.length) {
        metadata.attachments = attachments.map((a) => ({
          id: a.id,
          fileName: a.fileName,
          fileExt: a.fileExt,
        }));
      }
      if (spaceIds) {
        metadata.spaceIds = spaceIds;
      }

      const userMessage: AiChatMessage = {
        id: `temp-${Date.now()}`,
        chatId: session.chatId || "",
        role: "user",
        content,
        toolCalls: null,
        metadata: Object.keys(metadata).length ? metadata : null,
        createdAt: new Date().toISOString(),
      };

      session.messages = [...session.messages, userMessage];
      syncActiveSession(session);

      const attachmentIds = attachments.map((a) => a.id);

      const abortController = sendChatMessage(
        {
          chatId: session.chatId,
          content,
          mentionedPageIds: mentions.map((m) => m.id),
          ...(contextPageId && { contextPageId }),
          ...(attachmentIds.length && { attachmentIds }),
          ...(spaceIds && { spaceIds }),
          ...(responseMode && { responseMode }),
        },
        (event) => handleStreamEvent(event, session),
        (errorMsg) => {
          session.error = errorMsg;
          session.isStreaming = false;
          session.progressStage = null;
          session.thinkingSteps = [];
          session.abortController = null;
          syncActiveSession(session);
        },
        () => {
          session.isStreaming = false;
          session.abortController = null;
          syncActiveSession(session);
        },
      );

      session.abortController = abortController;
      if (activeSessionRef.current === session) {
        abortRef.current = abortController;
      }
    },
    [handleStreamEvent, isStreaming, syncActiveSession],
  );

  const editMessage = useCallback(
    (messageId: string, nextContent: string) => {
      const content = nextContent.trim();
      const currentChatId = currentChatIdRef.current;
      if (isStreaming || !currentChatId || !content) return;

      const session = activeSessionRef.current;
      if (!session) return;
      const messageIndex = session.messages.findIndex(
        (message) => message.id === messageId && message.role === "user",
      );
      if (messageIndex < 0) return;
      session.messages = session.messages
        .slice(0, messageIndex + 1)
        .map((message, index) =>
          index === messageIndex ? { ...message, content } : message,
        );
      session.error = null;
      session.errorCode = null;
      session.isRetryable = false;
      session.hydrated = true;
      session.isStreaming = true;
      session.progressStage = "permissions";
      session.thinkingSteps = [
        {
          step: "understanding",
          status: "started",
          startedAt: Date.now(),
        },
      ];
      session.streamingContent = "";
      session.streamingToolCalls = [];
      syncActiveSession(session);

      const reconcile = () => {
        void reconcileFromServer(currentChatId);
      };
      const abortController = editChatMessage(
        { chatId: currentChatId, messageId, content },
        (event) => {
          handleStreamEvent(event, session);
          if (event.type === "error") reconcile();
        },
        (errorMessage) => {
          session.error = errorMessage;
          session.isStreaming = false;
          session.progressStage = null;
          session.thinkingSteps = [];
          session.abortController = null;
          syncActiveSession(session);
          reconcile();
        },
        () => {
          session.isStreaming = false;
          session.abortController = null;
          syncActiveSession(session);
        },
      );
      session.abortController = abortController;
      abortRef.current = abortController;
    },
    [handleStreamEvent, isStreaming, reconcileFromServer, syncActiveSession],
  );

  const stopGeneration = useCallback(() => {
    const session = activeSessionRef.current;
    if (!session) return;
    session.abortController?.abort();
    session.abortController = null;
    abortRef.current = null;
    if (session.streamingContent || session.streamingToolCalls.length > 0) {
      session.messages = [
        ...session.messages,
        {
          id: `stopped-${Date.now()}`,
          chatId: session.chatId || currentChatIdRef.current || "",
          role: "assistant",
          content: session.streamingContent || null,
          toolCalls: session.streamingToolCalls.length
            ? session.streamingToolCalls
            : null,
          metadata: null,
          createdAt: new Date().toISOString(),
        },
      ];
    }
    session.streamingContent = "";
    session.streamingToolCalls = [];
    session.isStreaming = false;
    session.progressStage = null;
    session.thinkingSteps = [];
    syncActiveSession(session);
  }, [syncActiveSession]);

  return {
    messages,
    streamingContent,
    streamingToolCalls,
    isStreaming,
    progressStage,
    thinkingSteps,
    error,
    errorCode,
    isRetryable,
    sendMessage,
    editMessage,
    stopGeneration,
    hydrateFromServer,
  };
}

function buildAssistantMetadata(
  event: Extract<AiChatStreamEvent, { type: "done" }>,
): Record<string, unknown> | null {
  const metadata: Record<string, unknown> = {};
  if (event.usage) metadata.tokenUsage = event.usage;
  if (event.citations) metadata.citations = event.citations;
  if (event.citationEvidence)
    metadata.citationEvidence = event.citationEvidence;
  if (event.retrievedSources)
    metadata.retrievedSources = event.retrievedSources;
  if (event.retrievalDiagnostics) {
    metadata.retrievalDiagnostics = event.retrievalDiagnostics;
  }
  if (event.retrievalReasons)
    metadata.retrievalReasons = event.retrievalReasons;
  if (event.completenessNotice) {
    metadata.completenessNotice = event.completenessNotice;
  }
  if (event.answerMode) metadata.answerMode = event.answerMode;
  if (event.retrievalQuery) metadata.retrievalQuery = event.retrievalQuery;
  if (typeof event.canExpandScope === "boolean") {
    metadata.canExpandScope = event.canExpandScope;
  }
  if (event.thinkingTrace?.length) {
    metadata.thinkingTrace = event.thinkingTrace;
  }
  return Object.keys(metadata).length ? metadata : null;
}

function replaceOptimisticUserMessage(
  messages: AiChatMessage[],
  userMessageId: string | undefined,
  chatId: string,
): AiChatMessage[] {
  if (!userMessageId) return messages;

  let optimisticMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && message.id.startsWith("temp-")) {
      optimisticMessageIndex = index;
      break;
    }
  }

  if (optimisticMessageIndex < 0) return messages;

  const nextMessages = [...messages];
  nextMessages[optimisticMessageIndex] = {
    ...nextMessages[optimisticMessageIndex],
    id: userMessageId,
    chatId,
  };
  return nextMessages;
}

function upsertThinkingStep(
  steps: AiChatThinkingItem[],
  event: AiChatThinkingItem,
): AiChatThinkingItem[] {
  const index = steps.findIndex((item) => item.step === event.step);
  if (index < 0) return [...steps, event];

  const next = [...steps];
  const existing = next[index];
  next[index] = {
    ...existing,
    ...event,
    ...(event.status === "started"
      ? {
          startedAt:
            existing.status === "started" && existing.startedAt
              ? existing.startedAt
              : (event.startedAt ?? Date.now()),
        }
      : {}),
    ...((existing.stats || event.stats) && {
      stats: { ...existing.stats, ...event.stats },
    }),
  };
  return next;
}
