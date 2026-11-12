import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRecentPageVisits } from "../services/page-visit-service";
import { useRecentPageVisitsQuery } from "./page-visit-query";
import { IRecentPageVisit } from "../types/page-visit.types";

vi.mock("../services/page-visit-service", () => ({
  getRecentPageVisits: vi.fn(),
}));

const visit = (id: string): IRecentPageVisit => ({
  id,
  pageId: id,
  lastVisitedAt: "2026-11-11T08:00:00.000Z",
  page: { title: id, icon: null, slugId: id },
  space: { id: "space-1", name: "Product", slug: "product", logo: null },
});

function page(items: IRecentPageVisit[], nextCursor: string | null = null) {
  return {
    items,
    meta: {
      limit: 15,
      hasNextPage: nextCursor !== null,
      nextCursor,
      hasPrevPage: false,
      prevCursor: null,
    },
  };
}

describe("useRecentPageVisitsQuery", () => {
  beforeEach(() => vi.clearAllMocks());

  function wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }
  let queryClient: QueryClient;
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  it("loads beyond the first 15 visits and stops when history is exhausted", async () => {
    const first = Array.from({ length: 15 }, (_, index) =>
      visit(`visit-${index}`),
    );
    vi.mocked(getRecentPageVisits)
      .mockResolvedValueOnce(page(first, "older-visits"))
      .mockResolvedValueOnce(page([visit("visit-15")]));
    const { result } = renderHook(
      () => useRecentPageVisitsQuery(undefined, true),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });

    expect(getRecentPageVisits).toHaveBeenLastCalledWith({
      spaceId: undefined,
      limit: 15,
      cursor: "older-visits",
    });
    await waitFor(() =>
      expect(result.current.data?.pages.flatMap((p) => p.items)).toHaveLength(
        16,
      ),
    );
    expect(result.current.hasNextPage).toBe(false);
  });

  it("starts a separate first page when switching to the current space", async () => {
    vi.mocked(getRecentPageVisits)
      .mockResolvedValueOnce(page([visit("global-visit")], "global-cursor"))
      .mockResolvedValueOnce(page([visit("space-visit")]));
    const { result, rerender } = renderHook(
      ({ spaceId }: { spaceId: string | undefined }) =>
        useRecentPageVisitsQuery(spaceId, true),
      { wrapper, initialProps: { spaceId: undefined as string | undefined } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    rerender({ spaceId: "space-1" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getRecentPageVisits).toHaveBeenLastCalledWith({
      spaceId: "space-1",
      limit: 15,
      cursor: undefined,
    });
    expect(
      result.current.data?.pages.flatMap((p) => p.items).map((item) => item.id),
    ).toEqual(["space-visit"]);
  });
});
