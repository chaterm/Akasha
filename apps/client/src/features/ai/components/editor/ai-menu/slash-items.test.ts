import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/editor/utils/is-generative-ai-enabled", () => ({
  isGenerativeAiEnabled: () => true,
}));

import { getSlashCommandItems } from "./slash-items";

describe("getSlashCommandItems", () => {
  it("lists block commands after a slash, without Ask AI itself", () => {
    const items = getSlashCommandItems("/", null)!;

    expect(items.length).toBeGreaterThan(10);
    expect(items.some((item) => item.slashItem?.shortcut === "ai")).toBe(false);
    expect(items.every((item) => item.slashItem && item.id === `slash-${item.slashItem.shortcut}`)).toBe(true);
  });

  it("filters by the text after the slash", () => {
    expect(getSlashCommandItems("/table", null)![0].slashItem?.shortcut).toBe(
      "table",
    );
  });

  it("returns null for prompts that are not slash commands", () => {
    expect(getSlashCommandItems("写一份摘要", null)).toBeNull();
    expect(getSlashCommandItems("", null)).toBeNull();
  });
});
