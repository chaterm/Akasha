import { useQuery } from "@tanstack/react-query";
import {
  getAnalyticsOverview,
  getAnalyticsUsage,
  getAnalyticsUsageEvents,
} from "../services/analytics-service";
import {
  AnalyticsDateFilter,
  AnalyticsUsageFilter,
} from "../types/analytics.types";

export function useAnalyticsOverviewQuery(
  dates: AnalyticsDateFilter,
  spaceId: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ["analytics-overview", dates, spaceId],
    queryFn: () => getAnalyticsOverview({ ...dates, spaceId }),
    staleTime: 60_000,
    enabled,
  });
}

export function useAnalyticsUsageQuery(
  params: AnalyticsUsageFilter,
  enabled = true,
) {
  return useQuery({
    queryKey: ["analytics-usage", params],
    queryFn: () => getAnalyticsUsage(params),
    staleTime: 30_000,
    enabled,
  });
}

export function useAnalyticsUsageEventsQuery(
  params: AnalyticsUsageFilter,
  enabled = true,
) {
  return useQuery({
    queryKey: ["analytics-usage-events", params],
    queryFn: () => getAnalyticsUsageEvents(params),
    staleTime: 30_000,
    enabled,
  });
}
