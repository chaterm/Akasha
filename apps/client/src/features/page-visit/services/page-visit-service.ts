import api from "@/lib/api-client";
import { IRecentPageVisit } from "../types/page-visit.types";
import { IPagination } from "@/lib/types";

export async function recordPageVisit(pageId: string): Promise<void> {
  await api.post("/page-visits", { pageId });
}

export async function getRecentPageVisits(params: {
  spaceId?: string;
  limit?: number;
  cursor?: string;
}): Promise<IPagination<IRecentPageVisit>> {
  const response = await api.post<IPagination<IRecentPageVisit>>(
    "/page-visits/recent",
    params,
  );
  return response.data;
}
