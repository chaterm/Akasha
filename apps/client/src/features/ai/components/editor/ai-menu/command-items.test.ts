import { describe, expect, it } from "vitest";
import zhCN from "../../../../../../public/locales/zh-CN/translation.json";
import { commandItems, getVisibleCommandItems } from "./command-items";

const zh = zhCN as Record<string, string>;

describe("getVisibleCommandItems", () => {
  it("does not expose document-writing result actions in read mode", () => {
    const itemIds = getVisibleCommandItems("result", "", true).map(
      (item) => item.id,
    );

    expect(itemIds).not.toContain("result-replace");
    expect(itemIds).not.toContain("result-insert-below");
    expect(itemIds).toEqual([
      "result-copy",
      "result-discard",
      "result-try-again",
    ]);
  });

  it("matches commands by their translated name", () => {
    const translate = (name: string) => zh[name] ?? name;
    const itemIds = getVisibleCommandItems("main", "扩写", false, translate).map(
      (item) => item.id,
    );

    expect(itemIds).toEqual(["make-longer"]);
  });

  it("translates every command name and sends Chinese tone and language prompts", () => {
    const items = Object.values(commandItems).flat();

    expect(items.filter((item) => !zh[item.name]).map((item) => item.name)).toEqual(
      [],
    );
    expect(
      items
        .filter((item) => item.prompt)
        .every((item) => /[一-鿿]/.test(item.prompt!)),
    ).toBe(true);
  });

  it("keeps document-writing result actions in edit mode", () => {
    const itemIds = getVisibleCommandItems("result", "", false).map(
      (item) => item.id,
    );

    expect(itemIds).toContain("result-replace");
    expect(itemIds).toContain("result-insert-below");
  });
});
