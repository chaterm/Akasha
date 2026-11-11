import { diffWordsWithSpace } from "diff";

export type TitleDiffSegment = {
  value: string;
  type: "added" | "deleted" | "unchanged";
  diffIndex?: number;
};

export type TitleDiff = {
  segments: TitleDiffSegment[];
  addedCount: number;
  deletedCount: number;
};

export function computeTitleDiff(
  previousTitle: string | null | undefined,
  title: string | null | undefined,
): TitleDiff | null {
  const before = previousTitle ?? "";
  const after = title ?? "";
  if (before === after) return null;

  let addedCount = 0;
  let deletedCount = 0;
  const segments = diffWordsWithSpace(before, after).map(
    (part): TitleDiffSegment => {
      if (part.added) {
        addedCount++;
        return {
          value: part.value,
          type: "added",
          diffIndex: addedCount + deletedCount,
        };
      }
      if (part.removed) {
        deletedCount++;
        return {
          value: part.value,
          type: "deleted",
          diffIndex: addedCount + deletedCount,
        };
      }
      return { value: part.value, type: "unchanged" };
    },
  );

  return { segments, addedCount, deletedCount };
}
