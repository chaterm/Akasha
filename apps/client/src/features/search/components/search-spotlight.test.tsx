import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SearchSpotlight } from "./search-spotlight";
import { searchSpotlight } from "../constants";

const mocks = vi.hoisted(() => ({
  recentNext: vi.fn(),
  searchNext: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/time", () => ({ timeAgo: () => "5 minutes ago" }));
vi.mock("@/features/page-visit/queries/page-visit-query", () => ({
  useRecentPageVisitsQuery: () => ({
    data: { pages: [{ items: [] }] },
    isLoading: false,
    isError: false,
    hasNextPage: true,
    isFetchingNextPage: false,
    fetchNextPage: mocks.recentNext,
  }),
}));
vi.mock("../hooks/use-unified-search.ts", () => ({
  useUnifiedSearch: () => ({ data: [], isLoading: false }),
  usePageSearchInfinite: () => ({
    data: { pages: [{ items: [], total: 0 }] },
    isLoading: false,
    hasNextPage: true,
    isFetchingNextPage: false,
    fetchNextPage: mocks.searchNext,
  }),
}));
vi.mock("./search-spotlight-filters.tsx", () => ({
  SearchSpotlightFilters: () => null,
}));
vi.mock("./search-result-item.tsx", () => ({
  SearchResultItem: () => null,
}));

describe("SearchSpotlight scrolling", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
  });
  afterEach(() => {
    cleanup();
    searchSpotlight.close();
    vi.clearAllMocks();
  });

  it("loads recent history at the bottom and routes keyword searches to their own next page", async () => {
    searchSpotlight.open();
    render(
      <MantineProvider>
        <SearchSpotlight spaceId="space-1" />
      </MantineProvider>,
    );
    await screen.findByText("Recently viewed");
    const viewport = document.querySelector("[data-scrollbars]")!;
    expect(viewport).toBeTruthy();
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 800 },
    });

    fireEvent.scroll(viewport);
    expect(mocks.recentNext).toHaveBeenCalledOnce();
    expect(mocks.searchNext).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), {
      target: { value: "guide" },
    });
    fireEvent.scroll(viewport);
    expect(mocks.searchNext).toHaveBeenCalledOnce();
    expect(mocks.recentNext).toHaveBeenCalledOnce();
  });
});
