import { useRef, useState, type ReactNode } from "react";
import { IconGripVertical } from "@tabler/icons-react";
import { hitTestList, usePointerDrag } from "./use-pointer-drag";
import classes from "./database.module.css";

interface SortableListProps<T> {
  items: T[];
  getKey: (item: T) => string;
  /** Receives the dragged item's index and the "insert before" index. */
  onMove: (from: number, to: number) => void;
  renderItem: (item: T, index: number) => ReactNode;
  disabled?: boolean;
}

/** Vertical list reordered by dragging the grip on each row. */
export function SortableList<T>({
  items,
  getKey,
  onMove,
  renderItem,
  disabled,
}: SortableListProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const hit = (x: number, y: number) =>
    hitTestList(listRef.current, "[data-sort-item]", "y", x, y);
  const { onPointerDown, dragging } = usePointerDrag<number>({
    onMove: (_, x, y) => setDropIndex(hit(x, y)),
    onDrop: (from, x, y) => {
      setDropIndex(null);
      const to = hit(x, y);
      if (to !== from && to !== from + 1) onMove(from, to);
    },
    onCancel: () => setDropIndex(null),
  });

  return (
    <div ref={listRef} className={classes.sortableList}>
      {items.map((item, index) => (
        <div
          key={getKey(item)}
          data-sort-item
          className={classes.sortableItem}
          data-dragging={dragging === index || undefined}
        >
          {dropIndex === index && <div className={classes.sortIndicator} />}
          {!disabled && (
            <span
              className={classes.grip}
              onPointerDown={(event) =>
                onPointerDown(event, index, event.currentTarget.parentElement)
              }
            >
              <IconGripVertical size={14} />
            </span>
          )}
          <div className={classes.sortableContent}>
            {renderItem(item, index)}
          </div>
          {dropIndex === items.length && index === items.length - 1 && (
            <div className={classes.sortIndicatorAfter} />
          )}
        </div>
      ))}
    </div>
  );
}
