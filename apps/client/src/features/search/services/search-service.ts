import api from "@/lib/api-client";
import {
  IAttachmentSearch,
  IPageSearch,
  IPageSearchPage,
  IPageSearchParams,
  ISuggestionResult,
  SearchSuggestionParams,
} from "@/features/search/types/search.types";
import type { IPage } from "@/features/page/types/page.types";

export async function searchPage(
  params: IPageSearchParams,
): Promise<IPageSearch[]> {
  const req = await api.post<{ items: IPageSearch[] }>("/search", params);
  return req.data.items;
}

export async function searchPagePaged(
  params: IPageSearchParams,
): Promise<IPageSearchPage> {
  const req = await api.post<IPageSearchPage>("/search", params);
  return req.data;
}

export async function searchSuggestions(
  params: SearchSuggestionParams,
): Promise<ISuggestionResult> {
  const req = await api.post<ISuggestionResult>("/search/suggest", params);
  return req.data;
}

/** Title, icon and link of the pages the current user can read; others are left out. */
export async function resolvePages(pageIds: string[]): Promise<IPage[]> {
  const req = await api.post<{ pages: IPage[] }>("/search/resolve-pages", {
    pageIds,
  });
  return req.data.pages;
}

export async function searchShare(
  params: IPageSearchParams,
): Promise<IPageSearch[]> {
  const req = await api.post<{ items: IPageSearch[] }>(
    "/search/share-search",
    params,
  );
  return req.data.items;
}

export async function searchAttachments(
  params: IPageSearchParams,
): Promise<IAttachmentSearch[]> {
  const req = await api.post<{ items: IAttachmentSearch[] }>(
    "/search/attachments",
    params,
  );
  return req.data.items;
}
