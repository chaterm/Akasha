import { afterEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({ generative: false }));

vi.mock("@/features/editor/utils/is-generative-ai-enabled", () => ({
  isGenerativeAiEnabled: () => workspace.generative,
}));

import { findSlashMenuItem, getSuggestionItems } from "./menu-items";

const titles = (query: string, excludeItems?: Set<string>) =>
  Object.values(getSuggestionItems({ query, excludeItems }))
    .flat()
    .map((item) => item.title);

describe("slash menu shortcuts", () => {
  afterEach(() => {
    workspace.generative = false;
  });

  it("gives every command a unique shortcut", () => {
    const items = Object.values(getSuggestionItems({ query: "" })).flat();
    const shortcuts = items.map((item) => item.shortcut);
    expect(shortcuts.every((s) => /^[a-z0-9]+$/.test(s))).toBe(true);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it("ranks an exact shortcut match first", () => {
    expect(titles("h2")[0]).toBe("Heading 2");
    expect(titles("ul")[0]).toBe("Bullet list");
    expect(titles("col3")[0]).toBe("3 Columns");
  });

  it("ranks shortcut prefixes ahead of title matches", () => {
    expect(titles("math").slice(0, 2)).toEqual(["Math inline", "Math block"]);
  });

  it("shows Ask AI only when generative AI is enabled", () => {
    expect(titles("ai")).not.toContain("Ask AI");
    workspace.generative = true;
    expect(titles("ai")[0]).toBe("Ask AI");
    expect(titles("ai", new Set(["Ask AI"]))).not.toContain("Ask AI");
  });

  it("lists Ask AI first in the basic group when enabled", () => {
    expect(titles("")[0]).toBe("Text");
    workspace.generative = true;
    expect(titles("").slice(0, 2)).toEqual(["Ask AI", "Text"]);
  });

  it("looks commands up by shortcut", () => {
    expect(findSlashMenuItem("table")?.title).toBe("Table");
    expect(findSlashMenuItem("missing")).toBeUndefined();
  });
});
