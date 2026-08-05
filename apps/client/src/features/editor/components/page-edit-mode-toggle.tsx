import { MantineSize, SegmentedControl } from "@mantine/core";
import { useTranslation } from "react-i18next";
import {
  PageEditMode,
  usePageEditMode,
} from "@/features/editor/page-edit-mode-context";

export function PageEditModeToggle({ size }: { size?: MantineSize }) {
  const { t } = useTranslation();
  const { pageEditMode, setPageEditMode } = usePageEditMode();

  return (
    <SegmentedControl
      size={size}
      value={pageEditMode}
      onChange={(value) => setPageEditMode(value as PageEditMode)}
      data={[
        { label: t("Edit"), value: PageEditMode.Edit },
        { label: t("Read"), value: PageEditMode.Read },
      ]}
    />
  );
}
