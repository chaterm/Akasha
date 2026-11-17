import { generateJitteredKeyBetween } from "fractional-indexing-jittered";
import type { SpaceTreeNode } from "@/features/page/tree/types";
import type { IMovePage } from "@/features/page/types/page.types";
import type { DropOp } from "@/features/page/tree/model/tree-model.types";
import { treeModel } from "@/features/page/tree/model/tree-model";

export function dropOpToMovePayload(
  tree: SpaceTreeNode[],
  sourceId: string,
  op: DropOp,
): IMovePage {
  const { tree: after } = treeModel.move(tree, sourceId, op);
  const info = treeModel.siblingsOf(after, sourceId);
  if (!info) {
    return {
      pageId: sourceId,
      parentPageId: null,
      position: generateJitteredKeyBetween(null, null),
    };
  }

  const prev = info.siblings[info.index - 1] as SpaceTreeNode | undefined;
  const next = info.siblings[info.index + 1] as SpaceTreeNode | undefined;

  return {
    pageId: sourceId,
    parentPageId: info.parentId,
    position: generateJitteredKeyBetween(
      prev?.position ?? null,
      next?.position ?? null,
    ),
  };
}
