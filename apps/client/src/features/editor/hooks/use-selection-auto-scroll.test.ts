import { describe, expect, it } from "vitest";
import { selectionScrollSpeed } from "./use-selection-auto-scroll";

const TOP = 0;
const BOTTOM = 1000;

describe("selectionScrollSpeed", () => {
  it("stays still away from the edges", () => {
    expect(selectionScrollSpeed(500, TOP, BOTTOM)).toBe(0);
    expect(selectionScrollSpeed(300, TOP, BOTTOM)).toBe(0);
  });

  it("scrolls down near the bottom edge and up near the top edge", () => {
    expect(selectionScrollSpeed(980, TOP, BOTTOM)).toBeGreaterThan(0);
    expect(selectionScrollSpeed(20, TOP, BOTTOM)).toBeLessThan(0);
  });

  it("accelerates as the pointer approaches the edge", () => {
    const far = selectionScrollSpeed(910, TOP, BOTTOM);
    const near = selectionScrollSpeed(960, TOP, BOTTOM);
    const edge = selectionScrollSpeed(995, TOP, BOTTOM);
    expect(near).toBeGreaterThan(far);
    expect(edge).toBeGreaterThan(near);
    expect(edge).toBeLessThanOrEqual(8000);
  });

  it("jumps to the document boundary at and past the edges", () => {
    expect(selectionScrollSpeed(TOP, TOP, BOTTOM)).toBe(-Infinity);
    expect(selectionScrollSpeed(-40, TOP, BOTTOM)).toBe(-Infinity);
    expect(selectionScrollSpeed(BOTTOM, TOP, BOTTOM)).toBe(Infinity);
    expect(selectionScrollSpeed(BOTTOM + 120, TOP, BOTTOM)).toBe(Infinity);
  });

  it("respects a nested scroll container", () => {
    expect(selectionScrollSpeed(500, 200, 800)).toBe(0);
    expect(selectionScrollSpeed(790, 200, 800)).toBeGreaterThan(0);
    expect(selectionScrollSpeed(210, 200, 800)).toBeLessThan(0);
  });
});
