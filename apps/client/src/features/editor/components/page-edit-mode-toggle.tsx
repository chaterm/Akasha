import { Button, Loader, MantineSize, SegmentedControl } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { IconDeviceFloppy } from "@tabler/icons-react";
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

export function PageEditModeControls({ size }: { size?: MantineSize }) {
  const { t } = useTranslation();
  const { pageEditMode, savePage, isSaving } = usePageEditMode();
  const isEditMode = pageEditMode === PageEditMode.Edit;

  useHotkeys(
    [
      [
        "mod+S",
        () => {
          if (isEditMode) savePage();
        },
        { preventDefault: isEditMode },
      ],
    ],
    undefined,
    true,
  );

  return (
    <>
      <PageEditModeToggle size={size} />
      {isEditMode && (
        <Button
          size={size}
          leftSection={
            isSaving ? (
              <Loader size={14} color="currentColor" />
            ) : (
              <IconDeviceFloppy size={16} />
            )
          }
          onClick={savePage}
          disabled={isSaving}
          aria-busy={isSaving}
          aria-keyshortcuts="Control+S Meta+S"
        >
          {isSaving ? t("Saving...") : t("Save")}
        </Button>
      )}
    </>
  );
}
