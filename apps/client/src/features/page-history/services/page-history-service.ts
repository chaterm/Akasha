import api from "@/lib/api-client";
import {
  IPageHistory,
  IPageHistoryDiff,
} from "@/features/page-history/types/page.types";
import { IPagination } from "@/lib/types.ts";

export async function getPageHistoryList(
  pageId: string,
  cursor?: string,
): Promise<IPagination<IPageHistory>> {
  const req = await api.post("/pages/history", {
    pageId,
    cursor,
  });
  return req.data;
}

export async function createPageHistorySnapshot(
  pageId: string,
): Promise<IPageHistory & { created: boolean }> {
  const req = await api.post<IPageHistory & { created: boolean }>(
    "/pages/history/snapshot",
    {
      pageId,
    },
  );
  return req.data;
}

export async function getPageHistoryById(
  historyId: string,
): Promise<IPageHistory> {
  const req = await api.post<IPageHistory>("/pages/history/info", {
    historyId,
  });
  return req.data;
}

export async function getPageHistoryDiff(
  historyId: string,
): Promise<IPageHistoryDiff> {
  const req = await api.post<IPageHistoryDiff>("/pages/history/diff", {
    historyId,
  });
  return req.data;
}
