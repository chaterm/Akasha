import { afterEach, describe, expect, it, vi } from "vitest";
import api from "@/lib/api-client";
import { searchAttachments } from "./search-service";

vi.mock("@/lib/api-client", () => ({
  default: {
    post: vi.fn(),
  },
}));

describe("searchAttachments", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses the Web attachment search endpoint", async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { items: [] } });

    await expect(
      searchAttachments({ query: "guide", spaceId: "space-1" }),
    ).resolves.toEqual([]);
    expect(api.post).toHaveBeenCalledWith("/search/attachments", {
      query: "guide",
      spaceId: "space-1",
    });
  });
});
