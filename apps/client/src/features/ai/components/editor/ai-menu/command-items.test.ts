import { describe, expect, it } from "vitest";
import zhCN from "../../../../../../public/locales/zh-CN/translation.json";
import { commandItems, getVisibleCommandItems } from "./command-items";

const zh = zhCN as Record<string, string>;
const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("getVisibleCommandItems", () => {
  it("offers only rewriting commands for a selection", () => {
    expect(ids(getVisibleCommandItems("transform", "main", "", false))).toEqual([
      "improve-writing",
      "fix-spelling-grammar",
      "make-longer",
      "make-shorter",
      "summarize",
      "change-tone",
      "translate",
    ]);
  });

  it("has no fixed commands without a selection", () => {
    expect(getVisibleCommandItems("generate", "main", "", false)).toEqual([]);
  });

  it("replaces the selection and inserts at the cursor without one", () => {
    expect(ids(getVisibleCommandItems("transform", "result", "", false))).toEqual([
      "result-replace",
      "result-copy",
      "result-discard",
      "result-try-again",
    ]);
    expect(ids(getVisibleCommandItems("generate", "result", "", false))).toEqual([
      "result-insert",
      "result-copy",
      "result-discard",
      "result-try-again",
    ]);
  });

  it("does not expose document-writing result actions in read mode", () => {
    for (const mode of ["transform", "generate"] as const) {
      expect(ids(getVisibleCommandItems(mode, "result", "", true))).toEqual([
        "result-copy",
        "result-discard",
        "result-try-again",
      ]);
    }
  });

  it("matches commands by their translated name", () => {
    const translate = (name: string) => zh[name] ?? name;
    const itemIds = ids(
      getVisibleCommandItems("transform", "main", "扩写", false, translate),
    );

    expect(itemIds).toEqual(["make-longer"]);
  });

  it("translates every command name and sends Chinese tone and language prompts", () => {
    const items = Object.values(commandItems).flatMap((sets) =>
      Object.values(sets).flat(),
    );

    expect(items.filter((item) => !zh[item.name]).map((item) => item.name)).toEqual(
      [],
    );
    expect(
      items
        .filter((item) => item.prompt)
        .every((item) => /[一-鿿]/.test(item.prompt!)),
    ).toBe(true);
  });
});
