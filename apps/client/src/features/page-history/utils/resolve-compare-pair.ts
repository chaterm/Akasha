import { ComparePair } from "@/features/page-history/atoms/history-atoms";

export function resolveComparePair(
  historyItems: { id: string }[],
  selection: string[],
): ComparePair | null {
  if (selection.length !== 2) return null;
  const indexA = historyItems.findIndex((item) => item.id === selection[0]);
  const indexB = historyItems.findIndex((item) => item.id === selection[1]);
  if (indexA === -1 || indexB === -1 || indexA === indexB) return null;
  return indexA < indexB
    ? { newerId: selection[0], olderId: selection[1] }
    : { newerId: selection[1], olderId: selection[0] };
}
