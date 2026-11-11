import {
  usePageHistoryDiffQuery,
  usePageHistoryQuery,
} from "@/features/page-history/queries/page-history-query";
import { HistoryEditor } from "@/features/page-history/components/history-editor";
import { useTranslation } from "react-i18next";
import { useAtomValue } from "jotai";
import {
  activeHistoryIdAtom,
  activeHistoryPrevIdAtom,
} from "@/features/page-history/atoms/history-atoms";

interface Props {
  historyId?: string;
  prevHistoryId?: string;
}

function HistoryView({ historyId, prevHistoryId }: Props) {
  const { t } = useTranslation();
  const activeId = useAtomValue(activeHistoryIdAtom);
  const activePrevId = useAtomValue(activeHistoryPrevIdAtom);

  const isExplicitPair = historyId !== undefined;
  const resolvedId = historyId ?? activeId;
  const resolvedPrevId = prevHistoryId ?? activePrevId;

  const {
    data,
    isLoading: isLoadingCurrent,
    isError: isErrorCurrent,
  } = usePageHistoryQuery(resolvedId);
  const {
    data: diffData,
    isLoading: isLoadingDiff,
    isError: isErrorDiff,
  } = usePageHistoryDiffQuery(resolvedId, !isExplicitPair && !!resolvedPrevId);
  const shouldLoadPrevious =
    isExplicitPair ||
    isErrorDiff ||
    diffData?.status === "failed" ||
    (diffData?.status === "ready" && diffData.fromHistoryId !== resolvedPrevId);
  const {
    data: prevData,
    isLoading: isLoadingPrev,
    isError: isErrorPrev,
  } = usePageHistoryQuery(resolvedPrevId, shouldLoadPrevious);

  const previousTitle =
    prevData && !isErrorPrev
      ? prevData.title
      : !isExplicitPair &&
          diffData?.fromHistoryId &&
          diffData.fromHistoryId === resolvedPrevId &&
          diffData.fromTitle !== undefined
        ? diffData.fromTitle
        : undefined;

  if (isLoadingCurrent) {
    return <></>;
  }

  if (isErrorCurrent || !data) {
    return <div>{t("Error fetching page data.")}</div>;
  }

  return (
    <div>
      <HistoryEditor
        content={data.content}
        title={data.title}
        previousTitle={previousTitle}
        previousContent={!isErrorPrev ? prevData?.content : undefined}
        prevHistoryId={resolvedPrevId}
        persistedDiff={isExplicitPair ? undefined : diffData}
        isDiffLoading={isExplicitPair ? false : isLoadingDiff}
        isPreviousLoading={isLoadingPrev}
        isPreviousError={isErrorPrev}
      />
    </div>
  );
}

export default HistoryView;
