import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ChatInput from "./chat-input";

const mentionMocks = vi.hoisted(() => ({
  configure: vi.fn((_config: any) => ({
    extend: () => ({}),
  })),
  renderItems: vi.fn((_options?: { pageOnly?: boolean }) => ({})),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@tiptap/react", () => ({
  EditorContent: () => <div data-testid="editor-content" />,
  ReactNodeViewRenderer: () => undefined,
  useEditor: () => ({
    getJSON: () => ({ type: "doc", content: [] }),
    getText: () => "",
    commands: {
      clearContent: vi.fn(),
      focus: vi.fn(),
      insertContent: vi.fn(),
    },
  }),
}));

vi.mock("@tiptap/extension-placeholder", () => ({
  Placeholder: { configure: () => ({}) },
}));

vi.mock("@tiptap/extensions", () => ({
  CharacterCount: { configure: () => ({}) },
}));

vi.mock("@tiptap/starter-kit", () => ({
  StarterKit: { configure: () => ({}) },
}));

vi.mock("@docmost/editor-ext", () => ({
  LinkExtension: {},
  Mention: {
    configure: mentionMocks.configure,
  },
}));

vi.mock("@/features/editor/extensions/emoji-command", () => ({
  default: {},
}));

vi.mock("@/features/editor/components/mention/mention-suggestion", () => ({
  default: mentionMocks.renderItems,
}));

vi.mock("@/features/editor/components/mention/mention-view", () => ({
  default: () => null,
}));

describe("ChatInput", () => {
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
  });

  beforeEach(() => {
    mentionMocks.configure.mockClear();
    mentionMocks.renderItems.mockClear();
  });

  it("configures mention suggestions for pages only", () => {
    render(
      <MantineProvider>
        <ChatInput isStreaming={false} onSend={vi.fn()} onStop={vi.fn()} />
      </MantineProvider>,
    );

    const mentionConfig = mentionMocks.configure.mock.calls[0][0];
    mentionConfig.suggestion.render();

    expect(mentionMocks.renderItems).toHaveBeenCalledWith({ pageOnly: true });
  });

  it("disables file attachments while they are under active development", async () => {
    render(
      <MantineProvider>
        <ChatInput isStreaming={false} onSend={vi.fn()} onStop={vi.fn()} />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByLabelText("Add content"));

    const addFiles = await screen.findByRole("button", { name: /Add files/i });
    expect((addFiles as HTMLButtonElement).disabled).toBe(true);
    expect(addFiles.getAttribute("title")).toBe("正在快速开发中");
  });
});
