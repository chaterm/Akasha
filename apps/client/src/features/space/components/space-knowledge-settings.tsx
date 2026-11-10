import { SegmentedControl, Text } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ISpace } from "@/features/space/types/space.types.ts";
import { useUpdateSpaceMutation } from "@/features/space/queries/space-query.ts";
import type { KnowledgeSpaceIndexMode } from "@/features/page/services/page-service.ts";
import {
  ResponsiveSettingsContent,
  ResponsiveSettingsControl,
  ResponsiveSettingsRow,
} from "@/components/ui/responsive-settings-row.tsx";

type SpaceKnowledgeSettingsProps = {
  space: ISpace;
};

export default function SpaceKnowledgeSettings({
  space,
}: SpaceKnowledgeSettingsProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const updateSpaceMutation = useUpdateSpaceMutation();
  const savedMode: KnowledgeSpaceIndexMode =
    space.settings?.knowledge?.indexMode ?? "default";
  const [indexMode, setIndexMode] =
    useState<KnowledgeSpaceIndexMode>(savedMode);

  useEffect(() => {
    setIndexMode(savedMode);
  }, [savedMode]);

  const handleChange = async (value: string) => {
    if (value !== "default" && value !== "compiled" && value !== "original")
      return;
    const previous = indexMode;
    setIndexMode(value);
    try {
      await updateSpaceMutation.mutateAsync({
        spaceId: space.id,
        knowledgeIndexMode: value,
      });
      // Effective page modes and their lock state depend on this setting.
      await queryClient.invalidateQueries({
        queryKey: ["page-compile-status"],
      });
    } catch {
      // The mutation shows the error notification.
      setIndexMode(previous);
    }
  };

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text size="md">{t("Knowledge publishing")}</Text>
        <Text size="sm" c="dimmed">
          {t(
            "Default lets each page choose its publish mode; other options apply to every page in this space.",
          )}
        </Text>
      </ResponsiveSettingsContent>
      <ResponsiveSettingsControl>
        <SegmentedControl
          size="xs"
          value={indexMode}
          data={[
            { value: "default", label: t("Default") },
            { value: "original", label: t("Original text indexing") },
            { value: "compiled", label: t("Smart compilation") },
          ]}
          onChange={handleChange}
          disabled={updateSpaceMutation.isPending}
          aria-label={t("Default publish mode")}
        />
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
