import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ChatInput from "./chat-input";

const mentionMocks = vi.hoisted(() => ({
  configure: vi.fn((_config: any) => ({
    extend: () => ({}),
  })),
  renderItems: vi.fn((_options?: { pageOnly?: boolean }) => ({})),
}));

const editorMocks = vi.hoisted(() => ({
  setEditable: vi.fn(),
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
    setEditable: editorMocks.setEditable,
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
    editorMocks.setEditable.mockClear();
  });

  it("hides the add-content menu and keeps page mention suggestions", () => {
    render(
      <MantineProvider>
        <ChatInput isStreaming={false} onSend={vi.fn()} onStop={vi.fn()} />
      </MantineProvider>,
    );

    const mentionConfig = mentionMocks.configure.mock.calls[0][0];
    mentionConfig.suggestion.render();

    expect(screen.queryByLabelText("Add content")).toBeNull();
    expect(mentionMocks.renderItems).toHaveBeenCalledWith({ pageOnly: true });
  });

  it("disables the composer while a history message is being edited", () => {
    render(
      <MantineProvider>
        <ChatInput
          isStreaming={false}
          disabled
          onSend={vi.fn()}
          onStop={vi.fn()}
          contextPages={[{ id: "page-1", title: "Page", slugId: "page" }]}
        />
      </MantineProvider>,
    );

    expect(editorMocks.setEditable).toHaveBeenLastCalledWith(false);
    expect(
      (screen.getByLabelText("Send message") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
