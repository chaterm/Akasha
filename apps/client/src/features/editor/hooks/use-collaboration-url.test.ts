import { describe, expect, it } from "vitest";
import { buildCollaborationUrl } from "./use-collaboration-url";

describe("buildCollaborationUrl", () => {
  it("marks read-mode collaboration connections as read-only", () => {
    const url = buildCollaborationUrl(
      "wss://example.com/collab?existing=value",
      true,
    );
    const parsed = new URL(url);

    expect(parsed.searchParams.get("existing")).toBe("value");
    expect(parsed.searchParams.get("readOnly")).toBe("true");
  });

  it("marks edit-mode collaboration connections as writable", () => {
    const url = buildCollaborationUrl("wss://example.com/collab", false);

    expect(new URL(url).searchParams.get("readOnly")).toBe("false");
  });
});
