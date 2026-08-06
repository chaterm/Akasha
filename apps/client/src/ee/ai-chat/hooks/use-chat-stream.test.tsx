import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStream } from "./use-chat-stream";
import type { AiChatMessage } from "../types/ai-chat.types";

const serviceMocks = vi.hoisted(() => ({
  sendChatMessage: vi.fn(),
  editChatMessage: vi.fn(),
  getChatInfo: vi.fn(),
}));

vi.mock("../services/ai-chat-service", () => serviceMocks);

describe("useChatStream message editing", () => {
  beforeEach(() => {
    serviceMocks.sendChatMessage.mockReset();
    serviceMocks.editChatMessage.mockReset();
    serviceMocks.getChatInfo.mockReset();
  });

  it("replaces the optimistic user message id when sending finishes", async () => {
    serviceMocks.sendChatMessage.mockImplementation(
      (_params, onEvent: (event: Record<string, unknown>) => void) => {
        onEvent({ type: "content", text: "answer" });
        onEvent({
          type: "done",
          messageId: "assistant-1",
          userMessageId: "user-persisted-1",
          answerMode: "knowledge",
        });
        return new AbortController();
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useChatStream("chat-1"), { wrapper });

    act(() => {
      result.current.sendMessage("question");
    });

    await waitFor(() => {
      expect(result.current.messages.map((message) => message.id)).toEqual([
        "user-persisted-1",
        "assistant-1",
      ]);
    });
    expect(result.current.messages[0]).toMatchObject({
      chatId: "chat-1",
      role: "user",
      content: "question",
    });
    expect(result.current.messages[0].id).not.toMatch(/^temp-/);
  });

  it("replaces the edited question, truncates its tail, and appends the regenerated answer", async () => {
    serviceMocks.editChatMessage.mockImplementation(
      (_params, onEvent: (event: Record<string, unknown>) => void) => {
        onEvent({
          type: "message_edited",
          chatId: "chat-1",
          messageId: "user-2",
          content: "edited second question",
        });
        onEvent({ type: "progress", stage: "retrieval" });
        onEvent({
          type: "thinking",
          step: "searching",
          status: "started",
        });
        onEvent({
          type: "thinking",
          step: "searching",
          status: "completed",
          durationMs: 850,
          stats: { matchedChunkCount: 20, sourceCount: 4 },
        });
        onEvent({ type: "content", text: "new second answer" });
        onEvent({
          type: "done",
          messageId: "assistant-new",
          answerMode: "knowledge",
          thinkingTrace: [
            {
              step: "searching",
              status: "completed",
              durationMs: 850,
              stats: { matchedChunkCount: 20, sourceCount: 4 },
            },
          ],
        });
        return new AbortController();
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useChatStream("chat-1"), { wrapper });

    act(() => {
      result.current.hydrateFromServer([
        chatMessage("user-1", "user", "first question"),
        chatMessage("assistant-1", "assistant", "first answer"),
        chatMessage("user-2", "user", "second question"),
        chatMessage("assistant-2", "assistant", "old second answer"),
        chatMessage("user-3", "user", "third question"),
        chatMessage("assistant-3", "assistant", "third answer"),
      ]);
    });

    act(() => {
      (
        result.current as typeof result.current & {
          editMessage(messageId: string, content: string): void;
        }
      ).editMessage("user-2", " edited second question ");
    });

    await waitFor(() => {
      expect(result.current.messages.map((message) => message.id)).toEqual([
        "user-1",
        "assistant-1",
        "user-2",
        "assistant-new",
      ]);
    });
    expect(result.current.messages[2].content).toBe("edited second question");
    expect(result.current.messages[3].content).toBe("new second answer");
    expect(result.current.messages[3].metadata).toMatchObject({
      thinkingTrace: [
        {
          step: "searching",
          status: "completed",
          durationMs: 850,
          stats: { matchedChunkCount: 20, sourceCount: 4 },
        },
      ],
    });
    expect(serviceMocks.editChatMessage).toHaveBeenCalledWith(
      {
        chatId: "chat-1",
        messageId: "user-2",
        content: "edited second question",
      },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("invalidates the optimistic transcript when the edit stream reports an error", async () => {
    serviceMocks.editChatMessage.mockImplementation(
      (_params, onEvent: (event: Record<string, unknown>) => void) => {
        onEvent({
          type: "error",
          message: "Message not found",
          retryable: false,
        });
        return new AbortController();
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useChatStream("chat-1"), { wrapper });

    act(() => {
      result.current.hydrateFromServer([
        chatMessage("user-1", "user", "first question"),
        chatMessage("assistant-1", "assistant", "first answer"),
      ]);
    });

    act(() => {
      result.current.editMessage("user-1", "edited question");
    });

    await waitFor(() => {
      expect(result.current.error).toBe("Message not found");
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["ai-chat", "chat-1"],
      });
    });
  });

  it("replaces optimistic edit state with the authoritative transcript when persistence is superseded", async () => {
    const authoritativeMessages = [
      chatMessage("user-1", "user", "first question"),
      chatMessage("assistant-1", "assistant", "first answer"),
    ];
    serviceMocks.getChatInfo.mockResolvedValue({
      chat: { id: "chat-1" },
      messages: authoritativeMessages,
    });
    serviceMocks.editChatMessage.mockImplementation(
      (_params, onEvent: (event: Record<string, unknown>) => void) => {
        onEvent({
          type: "message_edited",
          chatId: "chat-1",
          messageId: "user-2",
          content: "edited second question",
        });
        onEvent({ type: "content", text: "answer that was not persisted" });
        onEvent({ type: "superseded", chatId: "chat-1" });
        return new AbortController();
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useChatStream("chat-1"), { wrapper });

    act(() => {
      result.current.hydrateFromServer([
        ...authoritativeMessages,
        chatMessage("user-2", "user", "second question"),
        chatMessage("assistant-2", "assistant", "old second answer"),
      ]);
    });
    act(() => {
      result.current.editMessage("user-2", "edited second question");
    });

    await waitFor(() => {
      expect(serviceMocks.getChatInfo).toHaveBeenCalledWith("chat-1");
      expect(result.current.messages).toEqual(authoritativeMessages);
    });
    expect(result.current.streamingContent).toBe("");
  });
});

function chatMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
): AiChatMessage {
  return {
    id,
    chatId: "chat-1",
    role,
    content,
    toolCalls: null,
    metadata: null,
    createdAt: "2026-07-30T00:00:00.000Z",
  };
}
