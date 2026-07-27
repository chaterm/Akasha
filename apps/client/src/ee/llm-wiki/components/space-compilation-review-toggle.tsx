import { Group, Switch, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateSpaceMutation } from "@/features/space/queries/space-query";
import type { ISpace } from "@/features/space/types/space.types";

type Props = {
  space: ISpace;
};

export default function SpaceCompilationReviewToggle({ space }: Props) {
  const { t } = useTranslation();
  const updateSpaceMutation = useUpdateSpaceMutation();
  const enabled =
    space.settings?.knowledge?.compilationReviewEnabled === true;
  const [checked, setChecked] = useState(enabled);

  useEffect(() => {
    setChecked(enabled);
  }, [enabled, space.id]);

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    try {
      await updateSpaceMutation.mutateAsync({
        spaceId: space.id,
        enableCompilationReview: value,
      });
      setChecked(value);
    } catch {
      // error handled by mutation
    }
  };

  return (
    <Group justify="space-between" wrap="nowrap" gap="xl" mt="lg">
      <div>
        <Text size="md">{t("Compilation content review")}</Text>
        <Text size="sm" c="dimmed">
          {t(
            "Allow space administrators to review compiled knowledge content with AI.",
          )}
        </Text>
      </div>
      <Switch
        checked={checked}
        onChange={handleChange}
        disabled={updateSpaceMutation.isPending}
        aria-label={t("Toggle compilation review")}
      />
    </Group>
  );
}
