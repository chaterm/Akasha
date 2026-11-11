import { describe, expect, it } from "vitest";
import { findBreadcrumbPath } from "./utils";
import type { SpaceTreeNode } from "../types";

function node(
  id: string,
  name: string,
  children: SpaceTreeNode[] = [],
): SpaceTreeNode {
  return {
    id,
    name,
    slugId: `slug-${id}`,
    position: "a0",
    hasChildren: children.length > 0,
    children,
  } as SpaceTreeNode;
}

describe("findBreadcrumbPath", () => {
  it("returns the path from the root to the page", () => {
    const tree = [node("a", "A", [node("b", "B", [node("c", "C")])])];

    const path = findBreadcrumbPath(tree, "c");

    expect(path?.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("returns null when the page is not in the tree", () => {
    expect(findBreadcrumbPath([node("a", "A")], "missing")).toBeNull();
  });

  it("leaves an untitled node's name untouched", () => {
    const tree = [node("a", "", [node("b", "   ")])];

    findBreadcrumbPath(tree, "b");

    expect(tree[0].name).toBe("");
    expect(tree[0].children[0].name).toBe("   ");
  });
});
