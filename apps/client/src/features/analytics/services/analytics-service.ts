import api from "@/lib/api-client";
import {
  AnalyticsDateFilter,
  AnalyticsUsageFilter,
  AnalyticsUsageOverview,
  AnalyticsUsageEvents,
  IAnalyticsOverview,
  ITrackPageView,
} from "../types/analytics.types";

export async function trackPageView(data: ITrackPageView): Promise<void> {
  await api.post("/analytics/track", data);
}

export async function getAnalyticsOverview(
  params: AnalyticsDateFilter & { spaceId?: string },
): Promise<IAnalyticsOverview> {
  const response = await api.get<IAnalyticsOverview>("/analytics/overview", {
    params,
  });
  return response.data;
}

export async function getAnalyticsUsage(
  params: AnalyticsUsageFilter,
): Promise<AnalyticsUsageOverview> {
  const response = await api.get<AnalyticsUsageOverview>("/analytics/usage", {
    params,
  });
  return response.data;
}

export async function getAnalyticsUsageEvents(
  params: AnalyticsUsageFilter,
): Promise<AnalyticsUsageEvents> {
  const response = await api.get<AnalyticsUsageEvents>(
    "/analytics/usage/events",
    { params },
  );
  return response.data;
}
