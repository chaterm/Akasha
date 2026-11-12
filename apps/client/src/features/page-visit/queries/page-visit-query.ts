import { useInfiniteQuery } from "@tanstack/react-query";
import { getRecentPageVisits } from "../services/page-visit-service";

export const RECENT_PAGE_VISITS_QUERY_KEY = "recent-page-visits";

export function useRecentPageVisitsQuery(
  spaceId: string | undefined,
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey: [RECENT_PAGE_VISITS_QUERY_KEY, spaceId],
    queryFn: ({ pageParam }) =>
      getRecentPageVisits({ spaceId, limit: 15, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.meta?.hasNextPage ? lastPage.meta.nextCursor : undefined,
    enabled,
    staleTime: 30_000,
  });
}
