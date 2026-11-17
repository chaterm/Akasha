import { useEffect, useRef } from "react";
import { matchPath, useLocation } from "react-router-dom";
import { extractPageSlugId } from "@/lib";
import { trackPageView } from "../services/analytics-service";
import { ITrackPageView } from "../types/analytics.types";

const ROUTE_PATTERNS: { pattern: string; route: string }[] = [
  { pattern: "/home", route: "home" },
  { pattern: "/ai", route: "ai" },
  { pattern: "/ai/chat/:chatId", route: "ai" },
  { pattern: "/spaces", route: "spaces" },
  { pattern: "/favorites", route: "favorites" },
  { pattern: "/analytics", route: "analytics" },
  { pattern: "/knowledge/graph", route: "graph" },
  { pattern: "/knowledge/admin", route: "knowledge.admin" },
  { pattern: "/labels/:labelName", route: "labels" },
  { pattern: "/templates/*", route: "templates" },
  { pattern: "/settings/*", route: "settings" },
  { pattern: "/s/:spaceSlug/p/:pageSlug", route: "space.page" },
  { pattern: "/s/:spaceSlug/graph", route: "graph" },
  { pattern: "/s/:spaceSlug/trash", route: "space.trash" },
  { pattern: "/s/:spaceSlug", route: "space.home" },
];

const DEDUPE_WINDOW_MS = 3000;

export function resolveTrackedRoute(pathname: string): ITrackPageView {
  for (const { pattern, route } of ROUTE_PATTERNS) {
    const match = matchPath({ path: pattern, end: true }, pathname);
    if (!match) continue;
    const { spaceSlug, pageSlug } = match.params;
    return {
      route,
      ...(spaceSlug ? { spaceSlug } : {}),
      ...(pageSlug ? { pageSlugId: extractPageSlugId(pageSlug) } : {}),
    };
  }
  return { route: "other" };
}

export function useRouteTracker() {
  const { pathname } = useLocation();
  const last = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    const payload = resolveTrackedRoute(pathname);
    const key = `${payload.route}|${payload.spaceSlug ?? ""}|${payload.pageSlugId ?? ""}`;
    const now = Date.now();
    if (last.current?.key === key && now - last.current.at < DEDUPE_WINDOW_MS) {
      return;
    }
    last.current = { key, at: now };
    void trackPageView(payload).catch(() => undefined);
  }, [pathname]);
}
