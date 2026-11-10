import { describe, expect, it } from "vitest";
import { computeTitleDiff } from "./title-diff";

describe("computeTitleDiff", () => {
  it("returns null when titles match", () => {
    expect(computeTitleDiff("Plan", "Plan")).toBeNull();
    expect(computeTitleDiff(null, "")).toBeNull();
  });

  it("marks replaced words and numbers each change in order", () => {
    const diff = computeTitleDiff("Hello world plan", "Hello there plan");
    expect(diff?.segments).toEqual([
      { value: "Hello ", type: "unchanged" },
      { value: "world", type: "deleted", diffIndex: 1 },
      { value: "there", type: "added", diffIndex: 2 },
      { value: " plan", type: "unchanged" },
    ]);
    expect(diff?.addedCount).toBe(1);
    expect(diff?.deletedCount).toBe(1);
  });

  it("handles CJK titles", () => {
    const diff = computeTitleDiff("项目周报", "项目月度总结");
    expect(diff?.segments.map((s) => [s.type, s.value])).toEqual([
      ["unchanged", "项目"],
      ["deleted", "周报"],
      ["added", "月度总结"],
    ]);
  });

  it("treats a title set from empty as a single addition", () => {
    expect(computeTitleDiff(null, "New page")).toEqual({
      segments: [{ value: "New page", type: "added", diffIndex: 1 }],
      addedCount: 1,
      deletedCount: 0,
    });
  });
});
