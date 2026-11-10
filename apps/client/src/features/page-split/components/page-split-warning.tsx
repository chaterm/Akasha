import { ActionIcon, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { pageEditorAtom } from "@/features/editor/atoms/editor-atoms.ts";
import { IPage } from "@/features/page/types/page.types.ts";
import { usePageContentStats } from "../hooks/use-page-content-stats";
import { limitStatus } from "../page-split.utils";
import { PageSplitModal } from "./page-split-modal";

/** 页面即将超限或已超限时显示，点击打开智能分页。 */
export function PageSplitWarning({ page }: { page: IPage }) {
  const { t } = useTranslation();
  const pageEditor = useAtomValue(pageEditorAtom);
  const stats = usePageContentStats(pageEditor);
  const status = limitStatus(stats);
  const [opened, { open, close }] = useDisclosure(false);

  const label =
    status === "over"
      ? t("Page content exceeds the limit. Click to split.")
      : t("Page content is close to the limit. Click to split.");

  return (
    <>
      {status !== "ok" && (
        <Tooltip label={label} openDelay={250} withArrow>
          <ActionIcon
            variant="subtle"
            color="yellow"
            aria-label={t("Smart split")}
            onClick={open}
          >
            <IconAlertTriangle size={20} stroke={2} />
          </ActionIcon>
        </Tooltip>
      )}
      {opened && <PageSplitModal page={page} opened={opened} onClose={close} />}
    </>
  );
}
