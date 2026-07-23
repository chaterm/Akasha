import { Button, Stack, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod/v4";
import { zod4Resolver } from "mantine-form-zod-resolver";
import {
  getSkillSettings,
  updateSkillSettings,
} from "@/features/workspace/services/workspace-service.ts";

const formSchema = z.object({
  latestVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  upgradeUrl: z
    .url()
    .refine(
      (value) => /^https?:\/\//i.test(value),
      "Use an HTTP or HTTPS URL.",
    ),
});

type FormValues = z.infer<typeof formSchema>;

export default function SkillSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);
  const { data: persistedSettings, isFetching: isReading } = useQuery({
    queryKey: ["skill-settings"],
    queryFn: getSkillSettings,
    refetchOnMount: "always",
  });
  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    initialValues: {
      latestVersion: "",
      upgradeUrl: "",
    },
  });

  useEffect(() => {
    if (!persistedSettings || form.isDirty()) {
      return;
    }

    const values = {
      latestVersion: persistedSettings.latestVersion ?? "",
      upgradeUrl: persistedSettings.upgradeUrl ?? "",
    };
    form.setValues(values);
    form.resetDirty(values);
  }, [persistedSettings]);

  const handleSubmit = async (values: FormValues) => {
    setIsSaving(true);
    try {
      await queryClient.cancelQueries({ queryKey: ["skill-settings"] });
      const updatedSettings = await updateSkillSettings(values);
      form.resetDirty(values);
      queryClient.setQueryData(["skill-settings"], updatedSettings);
      notifications.show({ message: t("Updated successfully") });
    } catch (error: any) {
      notifications.show({
        message: error?.response?.data?.message ?? t("Failed to update data"),
        color: "red",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={form.onSubmit(handleSubmit)}>
      <Stack gap="md">
        <div>
          <Text size="md">{t("Akasha Skill version management")}</Text>
          <Text size="sm" c="dimmed">
            {t(
              "Clients with an older Skill version receive a non-blocking update notice from Akasha.",
            )}
          </Text>
        </div>

        <TextInput
          label={t("Latest Skill version")}
          description={t("Use a stable semantic version such as 1.0.0.")}
          placeholder="1.0.0"
          disabled={isReading}
          {...form.getInputProps("latestVersion")}
        />

        <TextInput
          label={t("Skill upgrade URL")}
          description={t(
            "This link is included in the update notice shown to the user.",
          )}
          placeholder="https://github.com/.../skills"
          disabled={isReading}
          {...form.getInputProps("upgradeUrl")}
        />

        <Button
          type="submit"
          loading={isSaving}
          disabled={isReading || isSaving || !form.isDirty()}
          style={{ alignSelf: "flex-start" }}
        >
          {t("Save")}
        </Button>
      </Stack>
    </form>
  );
}
