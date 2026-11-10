import {
  InfiniteData,
  useInfiniteQuery,
  UseInfiniteQueryResult,
  useQuery,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  getPageHistoryById,
  getPageHistoryDiff,
  getPageHistoryList,
} from "@/features/page-history/services/page-history-service";
import {
  IPageHistory,
  IPageHistoryDiff,
} from "@/features/page-history/types/page.types";
import { IPagination } from "@/lib/types.ts";
import { queryClient } from "@/main";

const HISTORY_STALE_TIME = 60 * 60 * 1000;

export function prefetchPageHistory(historyId: string) {
  return queryClient.prefetchQuery({
    queryKey: ["page-history", historyId],
    queryFn: () => getPageHistoryById(historyId),
    staleTime: HISTORY_STALE_TIME,
  });
}

export function fetchPageHistory(historyId: string): Promise<IPageHistory> {
  return queryClient.fetchQuery({
    queryKey: ["page-history", historyId],
    queryFn: () => getPageHistoryById(historyId),
    staleTime: HISTORY_STALE_TIME,
  });
}

export function usePageHistoryListQuery(
  pageId: string,
): UseInfiniteQueryResult<InfiniteData<IPagination<IPageHistory>, unknown>> {
  return useInfiniteQuery({
    queryKey: ["page-history-list", pageId],
    queryFn: ({ pageParam }) => getPageHistoryList(pageId, pageParam),
    enabled: !!pageId,
    gcTime: 0,
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.meta?.nextCursor ?? undefined,
  });
}

export function usePageHistoryQuery(
  historyId: string,
  enabled = true,
): UseQueryResult<IPageHistory, Error> {
  return useQuery({
    queryKey: ["page-history", historyId],
    queryFn: () => getPageHistoryById(historyId),
    enabled: enabled && !!historyId,
    staleTime: HISTORY_STALE_TIME,
  });
}

export function usePageHistoryDiffQuery(
  historyId: string,
  enabled: boolean,
): UseQueryResult<IPageHistoryDiff, Error> {
  return useQuery({
    queryKey: ["page-history-diff", historyId],
    queryFn: () => getPageHistoryDiff(historyId),
    enabled: enabled && !!historyId,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "running" ? 1000 : false;
    },
  });
}
