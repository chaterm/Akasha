import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import type { TreeNode, DropOp } from "../model/tree-model.types";
import { treeModel } from "../model/tree-model";
import { DocTreeRow } from "./doc-tree-row";
import styles from "../styles/tree.module.css";

export type RenderRowProps<T extends object> = {
  node: TreeNode<T>;
  level: number;
  isOpen: boolean;
  hasChildren: boolean;
  isSelected: boolean;
  isDragging: boolean;
  isReceivingDrop: "before" | "after" | "make-child" | null;

  rowRef: Ref<HTMLElement>;
  tabIndex: 0 | -1;
  treeItemProps: {
    role: "treeitem";
    "aria-level": number;
    "aria-expanded"?: boolean;
    "aria-selected"?: true;
    "aria-current"?: "page";
    "aria-label": string;
    "data-row-id": string;
  };
  toggleOpen: () => void;
};

export type DocTreeProps<T extends object> = {
  data: TreeNode<T>[];
  openIds: ReadonlySet<string>;
  selectedId?: string;

  renderRow: (props: RenderRowProps<T>) => ReactNode;
  indentPerLevel?: number;
  rowHeight?: number;
  emptyState?: ReactNode;

  onMove: (sourceId: string, op: DropOp) => void | Promise<void>;
  onToggle: (id: string, isOpen: boolean) => void;
  onSelect?: (id: string) => void;

  readOnly?: boolean;
  disableDrag?: (node: TreeNode<T>) => boolean;
  disableDrop?: (node: TreeNode<T>) => boolean;

  getDragLabel: (node: TreeNode<T>) => string;
  uniqueContextId?: symbol;

  "aria-label"?: string;
};

export type DocTreeApi = {
  select: (
    id: string,
    opts?: { scrollIntoView?: boolean; focus?: boolean },
  ) => void;
  scrollTo: (id: string) => void;
  focus: (id: string) => void;
};

type FlatRow<T extends object> = {
  node: TreeNode<T>;
  level: number;
  isLastSibling: boolean;
};

function flattenVisible<T extends object>(
  data: TreeNode<T>[],
  openIds: ReadonlySet<string>,
): FlatRow<T>[] {
  const out: FlatRow<T>[] = [];
  const walk = (nodes: TreeNode<T>[], level: number) => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      out.push({ node, level, isLastSibling: i === nodes.length - 1 });
      if (openIds.has(node.id) && node.children?.length) {
        walk(node.children, level + 1);
      }
    }
  };
  walk(data, 0);
  return out;
}

type RowElementMap = Map<string, HTMLElement>;

function DocTreeInner<T extends object>(
  props: DocTreeProps<T>,
  ref: Ref<DocTreeApi>,
) {
  const {
    data,
    openIds,
    selectedId,
    renderRow,
    indentPerLevel = 16,
    rowHeight = 32,
    onMove,
    onToggle,
    onSelect,
    readOnly = false,
    disableDrag,
    disableDrop,
    getDragLabel,
    uniqueContextId,
    emptyState,
    "aria-label": ariaLabel,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowElementsRef = useRef<RowElementMap>(new Map());
  const pendingFocusIdRef = useRef<string | null>(null);
  const typeaheadBufferRef = useRef("");
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const contextId = useMemo(
    () => uniqueContextId ?? Symbol("doc-tree"),
    [uniqueContextId],
  );

  const registerRowElement = useCallback(
    (id: string, el: HTMLElement | null) => {
      if (el) {
        rowElementsRef.current.set(id, el);
        if (pendingFocusIdRef.current === id) {
          pendingFocusIdRef.current = null;
          requestAnimationFrame(() => el.focus());
        }
      } else {
        rowElementsRef.current.delete(id);
      }
    },
    [],
  );

  const rootDataRef = useRef(data);
  rootDataRef.current = data;
  const getRootData = useCallback(() => rootDataRef.current, []);

  const flat = useMemo(() => flattenVisible(data, openIds), [data, openIds]);

  const flatIds = useMemo(() => new Set(flat.map((r) => r.node.id)), [flat]);

  const effectiveActiveId = useMemo(() => {
    if (activeId && flatIds.has(activeId)) return activeId;
    if (selectedId && flatIds.has(selectedId)) return selectedId;
    return flat[0]?.node.id;
  }, [activeId, selectedId, flatIds, flat]);

  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });

  useImperativeHandle(
    ref,
    (): DocTreeApi => ({
      select: (id, opts) => {
        onSelect?.(id);
        const idx = flat.findIndex((r) => r.node.id === id);
        if (idx >= 0 && opts?.scrollIntoView) {
          virtualizer.scrollToIndex(idx, { align: "auto" });
        }
        if (opts?.focus) rowElementsRef.current.get(id)?.focus();
      },
      scrollTo: (id) => {
        const idx = flat.findIndex((r) => r.node.id === id);
        if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
      },
      focus: (id) => {
        rowElementsRef.current.get(id)?.focus();
      },
    }),
    [onSelect, flat, virtualizer],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    return autoScrollForElements({
      element: el,
      canScroll: ({ source }) => source.data.uniqueContextId === contextId,
    });
  }, [contextId]);

  const lastScrolledIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selectedId) {
      lastScrolledIdRef.current = undefined;
      return;
    }
    if (lastScrolledIdRef.current === selectedId) return;
    const idx = flat.findIndex((r) => r.node.id === selectedId);
    if (idx < 0) return;

    const containerHeight = scrollRef.current?.clientHeight ?? 0;
    const scrollOffset = virtualizer.scrollOffset ?? 0;
    const item = virtualizer.getVirtualItems().find((v) => v.index === idx);
    const isFullyVisible =
      !!item &&
      item.start >= scrollOffset &&
      item.start + item.size <= scrollOffset + containerHeight;

    if (!isFullyVisible) {
      virtualizer.scrollToIndex(idx, { align: "center" });
    }
    lastScrolledIdRef.current = selectedId;
  }, [selectedId, flat, virtualizer]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLUListElement>) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const isNavKey =
        !e.shiftKey &&
        (e.key === "ArrowDown" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "Home" ||
          e.key === "End");
      const isStarKey = e.key === "*";
      const isActivateKey = e.key === " ";
      const isTypeahead =
        e.key.length === 1 && !isNavKey && !isStarKey && !isActivateKey;
      if (!isNavKey && !isTypeahead && !isStarKey && !isActivateKey) return;

      const target = e.target as HTMLElement;
      if (target.matches('input, textarea, [contenteditable="true"]')) return;
      const rowEl = target.closest("[data-row-id]");
      if (!rowEl) return;
      const id = rowEl.getAttribute("data-row-id");
      if (!id) return;

      const idx = flat.findIndex((r) => r.node.id === id);
      if (idx < 0) return;

      const focusByIndex = (targetIdx: number) => {
        if (targetIdx < 0 || targetIdx >= flat.length) return;
        const targetId = flat[targetIdx].node.id;
        const existing = rowElementsRef.current.get(targetId);
        if (existing) {
          existing.focus();
        } else {
          pendingFocusIdRef.current = targetId;
          virtualizer.scrollToIndex(targetIdx, { align: "auto" });
        }
      };

      if (isActivateKey) {
        const registered = rowElementsRef.current.get(id);
        if (target === registered) {
          e.preventDefault();
          registered.click();
        }
        return;
      }

      if (isTypeahead) {
        e.preventDefault();
        const wasEmpty = typeaheadBufferRef.current.length === 0;
        typeaheadBufferRef.current = (
          typeaheadBufferRef.current + e.key
        ).toLowerCase();
        const buffer = typeaheadBufferRef.current;
        if (typeaheadTimerRef.current) {
          clearTimeout(typeaheadTimerRef.current);
        }
        typeaheadTimerRef.current = setTimeout(() => {
          typeaheadBufferRef.current = "";
          typeaheadTimerRef.current = null;
        }, 500);
        const startIdx = wasEmpty ? (idx + 1) % flat.length : idx;
        for (let i = 0; i < flat.length; i++) {
          const probeIdx = (startIdx + i) % flat.length;
          const label = getDragLabel(flat[probeIdx].node).toLowerCase();
          if (label.startsWith(buffer)) {
            focusByIndex(probeIdx);
            break;
          }
        }
        return;
      }

      const row = flat[idx];
      const hasChildren =
        (row.node.children && row.node.children.length > 0) ||
        (row.node as { hasChildren?: boolean }).hasChildren === true;
      const isOpen = openIds.has(row.node.id);

      if (isStarKey) {
        e.preventDefault();
        const info = treeModel.siblingsOf(rootDataRef.current, row.node.id);
        if (info) {
          for (const sib of info.siblings) {
            const sibHasChildren =
              (sib.children && sib.children.length > 0) ||
              (sib as { hasChildren?: boolean }).hasChildren === true;
            if (sibHasChildren && !openIds.has(sib.id)) {
              onToggle(sib.id, true);
            }
          }
        }
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          focusByIndex(idx + 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          focusByIndex(idx - 1);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (hasChildren && !isOpen) {
            onToggle(row.node.id, true);
          } else if (
            isOpen &&
            row.node.children &&
            row.node.children.length > 0
          ) {
            focusByIndex(idx + 1);
          }
          break;
        case "ArrowLeft": {
          e.preventDefault();
          if (isOpen && hasChildren) {
            onToggle(row.node.id, false);
          } else {
            const currentLevel = row.level;
            for (let i = idx - 1; i >= 0; i--) {
              if (flat[i].level < currentLevel) {
                focusByIndex(i);
                break;
              }
            }
          }
          break;
        }
        case "Home":
          e.preventDefault();
          focusByIndex(0);
          break;
        case "End":
          e.preventDefault();
          focusByIndex(flat.length - 1);
          break;
      }
    },
    [flat, openIds, onToggle, virtualizer, getDragLabel],
  );

  useEffect(
    () => () => {
      if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
    },
    [],
  );

  const handleFocusIn = useCallback((e: React.FocusEvent<HTMLUListElement>) => {
    const rowEl = (e.target as HTMLElement).closest("[data-row-id]");
    const id = rowEl?.getAttribute("data-row-id");
    if (id) setActiveId(id);
  }, []);

  if (data.length === 0 && emptyState) {
    return <div className={styles.treeContainer}>{emptyState}</div>;
  }

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <div ref={scrollRef} className={styles.treeContainer}>
      <ul
        role="tree"
        aria-label={ariaLabel}
        onKeyDown={handleKeyDown}
        onFocus={handleFocusIn}
        style={{
          position: "relative",
          height: totalSize,
          margin: 0,
          padding: 0,
          listStyle: "none",
        }}
      >
        {virtualItems.map((virtualItem) => {
          const row = flat[virtualItem.index];
          return (
            <li
              key={row.node.id}
              role="none"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <DocTreeRow
                node={row.node}
                level={row.level}
                isLastSibling={row.isLastSibling}
                openIds={openIds}
                selectedId={selectedId}
                activeId={effectiveActiveId}
                renderRow={renderRow}
                indentPerLevel={indentPerLevel}
                onMove={onMove}
                onToggle={onToggle}
                readOnly={readOnly}
                disableDrag={disableDrag}
                disableDrop={disableDrop}
                getDragLabel={getDragLabel}
                contextId={contextId}
                registerRowElement={registerRowElement}
                getRootData={getRootData}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export const DocTree = forwardRef(DocTreeInner) as <T extends object>(
  props: DocTreeProps<T> & { ref?: Ref<DocTreeApi> },
) => ReturnType<typeof DocTreeInner>;
