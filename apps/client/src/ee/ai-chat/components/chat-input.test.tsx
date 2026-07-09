import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import ChatInput from "./chat-input";

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
    configure: () => ({
      extend: () => ({}),
    }),
  },
}));

vi.mock("@/features/editor/extensions/emoji-command", () => ({
  default: {},
}));

vi.mock("@/features/editor/components/mention/mention-suggestion", () => ({
  default: vi.fn(),
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
