import { useAtom } from "jotai";
import { useEffect } from "react";
import {
  activeHistoryIdAtom,
  activeHistoryPrevIdAtom,
  compareModeAtom,
  comparePairAtom,
  compareSelectionAtom,
  diffCountsAtom,
  diffStateAtom,
} from "@/features/page-history/atoms/history-atoms";

export function useHistoryReset(pageId: string) {
  const [, setActiveHistoryId] = useAtom(activeHistoryIdAtom);
  const [, setActiveHistoryPrevId] = useAtom(activeHistoryPrevIdAtom);
  const [, setDiffCounts] = useAtom(diffCountsAtom);
  const [, setDiffState] = useAtom(diffStateAtom);
  const [, setCompareMode] = useAtom(compareModeAtom);
  const [, setCompareSelection] = useAtom(compareSelectionAtom);
  const [, setComparePair] = useAtom(comparePairAtom);

  useEffect(() => {
    const resetCompare = () => {
      setCompareMode(false);
      setCompareSelection([]);
      setComparePair(null);
    };

    setActiveHistoryId("");
    setActiveHistoryPrevId("");
    setDiffCounts(null);
    setDiffState("idle");
    resetCompare();

    return resetCompare;
  }, [
    pageId,
    setActiveHistoryId,
    setActiveHistoryPrevId,
    setDiffCounts,
    setDiffState,
    setCompareMode,
    setCompareSelection,
    setComparePair,
  ]);
}
