import { beforeEach, describe, expect, it, vi } from "vitest";
import api from "@/lib/api-client";
import { getRecentPageVisits, recordPageVisit } from "./page-visit-service";

vi.mock("@/lib/api-client", () => ({
  default: { post: vi.fn() },
}));

describe("page visit service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records the page only through the explicit visit endpoint", async () => {
    vi.mocked(api.post).mockResolvedValue({ data: undefined });

    await recordPageVisit("page-1");

    expect(api.post).toHaveBeenCalledWith("/page-visits", { pageId: "page-1" });
  });

  it("loads recent visits using the active space scope", async () => {
    const items = [{ id: "visit-1" }];
    const meta = { hasNextPage: true, nextCursor: "next-visit" };
    vi.mocked(api.post).mockResolvedValue({ data: { items, meta } });

    await expect(
      getRecentPageVisits({ spaceId: "space-1", limit: 15 }),
    ).resolves.toEqual({ items, meta });
    expect(api.post).toHaveBeenCalledWith("/page-visits/recent", {
      spaceId: "space-1",
      limit: 15,
    });
  });
});
