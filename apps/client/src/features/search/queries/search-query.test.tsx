import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSearchSuggestionsQuery } from "./search-query";

const searchMocks = vi.hoisted(() => ({
  suggestions: vi.fn(),
}));

vi.mock("@/features/search/services/search-service", () => ({
  searchSuggestions: searchMocks.suggestions,
  searchAttachments: vi.fn(),
  searchPage: vi.fn(),
  searchShare: vi.fn(),
}));

describe("useSearchSuggestionsQuery", () => {
  beforeEach(() => {
    searchMocks.suggestions.mockReset();
    searchMocks.suggestions
      .mockResolvedValueOnce({ pages: [{ id: "page-1" }] })
      .mockResolvedValueOnce({ users: [{ id: "user-1" }] });
  });

  it("keeps page-only and people-enabled suggestions in separate caches", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { rerender } = renderHook(
      ({ includeUsers }) =>
        useSearchSuggestionsQuery({
          query: "roadmap",
          includeUsers,
          includePages: true,
          limit: 10,
          preload: true,
        }),
      { wrapper, initialProps: { includeUsers: false } },
    );

    await waitFor(() =>
      expect(searchMocks.suggestions).toHaveBeenCalledTimes(1),
    );

    rerender({ includeUsers: true });

    await waitFor(() =>
      expect(searchMocks.suggestions).toHaveBeenCalledTimes(2),
    );
    expect(searchMocks.suggestions).toHaveBeenLastCalledWith({
      query: "roadmap",
      includeUsers: true,
      includePages: true,
      limit: 10,
    });
  });
});
