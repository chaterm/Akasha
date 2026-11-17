import { IPage } from "@/features/page/types/page.types.ts";
import { sortPositionKeys } from "@/features/page/tree/utils";

export type SharedPageTreeNode = {
  id: string;
  slugId: string;
  name: string;
  icon?: string;
  position: string;
  spaceId: string;
  parentPageId: string;
  updatedAt?: Date;
  hasChildren: boolean;
  children: SharedPageTreeNode[];
  label: string;
  value: string;
};

export function buildSharedPageTree(
  pages: Partial<IPage[]>,
): SharedPageTreeNode[] {
  const pageMap: Record<string, SharedPageTreeNode> = {};

  pages.forEach((page) => {
    pageMap[page.id] = {
      id: page.slugId,
      slugId: page.slugId,
      name: page.title,
      icon: page.icon,
      position: page.position,
      hasChildren: false,
      spaceId: page.spaceId,
      parentPageId: page.parentPageId,
      updatedAt: page.updatedAt,
      label: page.title || "untitled",
      value: page.id,
      children: [],
    };
  });

  const tree: SharedPageTreeNode[] = [];
  pages.forEach((page) => {
    if (page.parentPageId) {
      const parentNode = pageMap[page.parentPageId];
      if (parentNode) {
        parentNode.children.push(pageMap[page.id]);
        parentNode.hasChildren = true;
      } else {
        tree.push(pageMap[page.id]);
      }
    } else {
      tree.push(pageMap[page.id]);
    }
  });

  function sortTree(nodes: SharedPageTreeNode[]): SharedPageTreeNode[] {
    return sortPositionKeys(nodes).map((node: SharedPageTreeNode) => ({
      ...node,
      children: sortTree(node.children),
    }));
  }

  return sortTree(tree);
}

export function findSubpagesInTree(
  tree: SharedPageTreeNode[] | null | undefined,
  pageId: string | undefined,
): SharedPageTreeNode[] {
  if (!tree || !pageId) return [];

  for (const node of tree) {
    if (node.value === pageId || node.slugId === pageId) {
      return node.children || [];
    }
    if (node.children && node.children.length > 0) {
      const subpages = findSubpagesInTree(node.children, pageId);
      if (subpages.length > 0) {
        return subpages;
      }
    }
  }
  return [];
}

export function isPageInTree(
  tree: SharedPageTreeNode[],
  pageSlugId: string,
): boolean {
  for (const node of tree) {
    if (node.slugId === pageSlugId) {
      return true;
    }
    if (isPageInTree(node.children, pageSlugId)) {
      return true;
    }
  }
  return false;
}
