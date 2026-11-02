import { useEffect, useMemo, useState } from "react";
import type { DatabaseColumn, DatabaseSelectOption } from "@docmost/editor-ext";

/** What a viewer may see of a referenced document. */
export interface PageInfo {
  title: string;
  icon?: string;
  slugId: string;
  spaceSlug?: string;
}

/** Shared across databases: page id -> info, or null when the viewer cannot see it. */
const cache = new Map<string, PageInfo | null>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

const BATCH = 200;

async function load(ids: string[]) {
  ids.forEach((id) => inFlight.add(id));
  try {
    // Loaded on demand so the database view does not pull in the API client up front.
    const { resolvePages } =
      await import("@/features/search/services/search-service");
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const pages = await resolvePages(chunk);
      const byId = new Map(pages.map((page) => [page.id, page]));
      for (const id of chunk) {
        const page = byId.get(id);
        cache.set(
          id,
          page
            ? {
                title: page.title ?? "",
                icon: page.icon || undefined,
                slugId: page.slugId,
                spaceSlug: page.space?.slug,
              }
            : null,
        );
      }
    }
  } catch {
    // Left unresolved: shown as loading, retried when the set of ids changes.
  } finally {
    ids.forEach((id) => inFlight.delete(id));
    notify();
  }
}

/** A page just picked from search is known to be visible; no lookup needed. */
export function rememberPage(id: string, info: PageInfo) {
  cache.set(id, info);
  notify();
}

/** Looks up the referenced pages with the viewer's permissions. */
export function usePageInfo(ids: string[]): Map<string, PageInfo | null> {
  const [version, setVersion] = useState(0);
  const key = [...new Set(ids)].sort().join(",");

  useEffect(() => {
    const rerender = () => setVersion((value) => value + 1);
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, []);

  useEffect(() => {
    const missing = key
      .split(",")
      .filter((id) => id && !cache.has(id) && !inFlight.has(id));
    if (missing.length) void load(missing);
  }, [key]);

  // A new Map on every change so memoized consumers recompute.
  return useMemo(() => new Map(cache), [key, version]);
}

/** Page ids referenced by the document columns' options. */
export function pageIdsOf(columns: DatabaseColumn[]): string[] {
  return columns
    .filter((column) => column.type === "page")
    .flatMap((column) => (column.options ?? []).map((option) => option.id));
}

/**
 * Document columns with the viewer's view of each page filled in: title, icon
 * and link when visible, `unavailable` when not. Nothing here is written back.
 */
export function withPageInfo(
  columns: DatabaseColumn[],
  info: Map<string, PageInfo | null>,
): DatabaseColumn[] {
  return columns.map((column) => {
    if (column.type !== "page") return column;
    return {
      ...column,
      options: (column.options ?? []).map((option): DatabaseSelectOption => {
        const page = info.get(option.id);
        if (page === undefined) return option;
        if (page === null) return { ...option, unavailable: true };
        return {
          ...option,
          name: page.title,
          icon: page.icon,
          slugId: page.slugId,
          spaceSlug: page.spaceSlug,
        };
      }),
    };
  });
}
