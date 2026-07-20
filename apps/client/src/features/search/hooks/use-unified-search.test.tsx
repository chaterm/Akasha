import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchAttachments, searchPage } from "../services/search-service";
import { useUnifiedSearch } from "./use-unified-search";

vi.mock("../services/search-service", () => ({
  searchAttachments: vi.fn(),
  searchPage: vi.fn(),
}));

vi.mock("@/ee/hooks/use-feature", () => ({
  useHasFeature: () => false,
}));

describe("useUnifiedSearch", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("routes attachment searches without an enterprise entitlement", async () => {
    vi.mocked(searchAttachments).mockResolvedValue([]);
    vi.mocked(searchPage).mockResolvedValue([]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () =>
        useUnifiedSearch({
          query: "guide",
          contentType: "attachment",
          spaceId: "space-1",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(searchAttachments).toHaveBeenCalledWith({
      query: "guide",
      spaceId: "space-1",
    });
    expect(searchPage).not.toHaveBeenCalled();
  });
});
