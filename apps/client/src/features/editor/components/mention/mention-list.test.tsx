import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import MentionList from "./mention-list";

const mentionListMocks = vi.hoisted(() => ({
  searchSuggestions: vi.fn(),
  suggestionResult: {
    data: { users: [], pages: [] },
    isLoading: false,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-router-dom", () => ({
  useParams: () => ({}),
}));

vi.mock("@/features/search/queries/search-query.ts", () => ({
  useSearchSuggestionsQuery: mentionListMocks.searchSuggestions,
}));

vi.mock("@/features/space/queries/space-query.ts", () => ({
  useSpaceQuery: () => ({ data: { id: "space-1" } }),
}));

vi.mock("@/features/page/queries/page-query", () => ({
  usePageQuery: () => ({ data: {} }),
  useCreatePageMutation: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/features/websocket/use-query-emit", () => ({
  useQueryEmit: () => vi.fn(),
}));

vi.mock("jotai", () => ({
  useAtom: () => [{ user: { id: "user-1" } }, vi.fn()],
}));

vi.mock("@/features/user/atoms/current-user-atom.ts", () => ({
  currentUserAtom: {},
}));

vi.mock("@/features/page/tree/atoms/tree-data-atom", () => ({
  treeDataAtom: {},
}));

describe("MentionList page-only search", () => {
  beforeAll(() => {
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
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
    mentionListMocks.searchSuggestions.mockClear();
    mentionListMocks.searchSuggestions.mockReturnValue(
      mentionListMocks.suggestionResult,
    );
  });

  it("preloads five pages and searches ten pages without users", () => {
    const editor = { storage: {} } as any;
    const baseProps = {
      command: vi.fn(),
      editor,
      items: [] as [],
      range: { from: 0, to: 0 },
      text: "",
      pageOnly: true,
    };

    const { rerender } = render(
      <MantineProvider>
        <MentionList {...baseProps} query="" />
      </MantineProvider>,
    );

    expect(mentionListMocks.searchSuggestions).toHaveBeenLastCalledWith({
      query: "",
      includeUsers: false,
      includePages: true,
      spaceId: "space-1",
      limit: 5,
      preload: true,
    });

    rerender(
      <MantineProvider>
        <MentionList {...baseProps} query="roadmap" />
      </MantineProvider>,
    );

    expect(mentionListMocks.searchSuggestions).toHaveBeenLastCalledWith({
      query: "roadmap",
      includeUsers: false,
      includePages: true,
      spaceId: "space-1",
      limit: 10,
      preload: true,
    });
  });

  it("never renders people in a page-only mention list", async () => {
    mentionListMocks.searchSuggestions.mockReturnValue({
      data: {
        users: [{ id: "user-1", name: "Alice", avatarUrl: null }],
        pages: [
          {
            id: "page-1",
            title: "Roadmap",
            slugId: "roadmap-abc123",
            icon: null,
          },
        ],
      },
      isLoading: false,
    });

    render(
      <MantineProvider>
        <MentionList
          command={vi.fn()}
          editor={{ storage: {} } as any}
          items={[]}
          range={{ from: 0, to: 0 }}
          text=""
          pageOnly
          query="roadmap"
        />
      </MantineProvider>,
    );

    await screen.findByText("Roadmap");
    expect(screen.queryByText("Alice")).toBeNull();
    expect(screen.queryByText("People")).toBeNull();
  });
});
