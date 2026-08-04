import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import ChatMessageList from "./chat-message-list";
import type { AiChatMessage } from "../types/ai-chat.types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("ChatMessageList editing", () => {
  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    HTMLElement.prototype.scrollTo = vi.fn();
  });

  it("wires persisted user-message editing and reports inline-editor state", () => {
    const onEditMessage = vi.fn();
    const onEditingStateChange = vi.fn();
    render(
      <MantineProvider>
        <MemoryRouter>
          <ChatMessageList
            messages={[message("user-1", "user", "Original question")]}
            isStreaming={false}
            streamingContent=""
            streamingToolCalls={[]}
            onEditMessage={onEditMessage}
            onEditingStateChange={onEditingStateChange}
          />
        </MemoryRouter>
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    expect(onEditingStateChange).toHaveBeenLastCalledWith(true);

    fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), {
      target: { value: "Edited question" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save and regenerate" }),
    );

    expect(onEditMessage).toHaveBeenCalledWith("user-1", "Edited question");
    expect(onEditingStateChange).toHaveBeenLastCalledWith(false);
  });
});

function message(
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
