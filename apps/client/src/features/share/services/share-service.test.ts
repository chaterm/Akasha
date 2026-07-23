import { afterEach, describe, expect, it, vi } from "vitest";
import api from "@/lib/api-client";
import { getShareForPage } from "./share-service";

vi.mock("@/lib/api-client", () => ({
  default: {
    post: vi.fn(),
  },
}));

describe("getShareForPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when an unshared page response has no data", async () => {
    vi.mocked(api.post).mockResolvedValue({ success: true, status: 200 });

    await expect(getShareForPage("page-1")).resolves.toBeNull();

    expect(api.post).toHaveBeenCalledWith("/shares/for-page", {
      pageId: "page-1",
    });
  });
});
