import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasUsableDragCoords } from "./drag-handle";
import { autoScrollSpeed } from "@/features/editor/utils/auto-scroll";

describe("hasUsableDragCoords", () => {
  it("ignores the (0, 0) event browsers fire as a drag ends", () => {
    expect(hasUsableDragCoords({ clientX: 0, clientY: 0 })).toBe(false);
  });

  it("accepts coordinates on either axis", () => {
    expect(hasUsableDragCoords({ clientX: 0, clientY: 40 })).toBe(true);
    expect(hasUsableDragCoords({ clientX: 600, clientY: 0 })).toBe(true);
    expect(hasUsableDragCoords({ clientX: 600, clientY: 400 })).toBe(true);
  });

  it("accepts coordinates past the viewport, which drive the jump to the end", () => {
    expect(hasUsableDragCoords({ clientX: 600, clientY: -40 })).toBe(true);
    expect(hasUsableDragCoords({ clientX: 600, clientY: 2000 })).toBe(true);
  });
});

describe("drag autoscroll speed", () => {
  let innerHeight: number;

  beforeEach(() => {
    innerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerHeight", {
      value: innerHeight,
      configurable: true,
    });
  });

  const at = (clientY: number) => autoScrollSpeed(clientY, 0, 800);

  it("stays still away from the edges", () => {
    expect(at(400)).toBe(0);
  });

  it("scrolls up near the top edge and down near the bottom", () => {
    expect(at(40)).toBeLessThan(0);
    expect(at(780)).toBeGreaterThan(0);
  });

  it("accelerates as the pointer approaches the edge", () => {
    expect(at(760)).toBeGreaterThan(at(720));
    expect(at(795)).toBeGreaterThan(at(760));
  });

  it("runs to the boundary once the pointer leaves the viewport", () => {
    expect(at(0)).toBe(-Infinity);
    expect(at(-120)).toBe(-Infinity);
    expect(at(800)).toBe(Infinity);
    expect(at(2000)).toBe(Infinity);
  });
});
