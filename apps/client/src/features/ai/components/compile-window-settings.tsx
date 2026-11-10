import { Button, Group, Stack, Switch, Text } from "@mantine/core";
import { TimePicker } from "@mantine/dates";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod/v4";
import { zod4Resolver } from "mantine-form-zod-resolver";
import {
  getCompileWindowSettings,
  updateCompileWindowSettings,
} from "@/features/workspace/services/workspace-service.ts";
import { notifyError } from "@/lib/errors";

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const QUERY_KEY = ["compile-window-settings"];

const formSchema = z
  .object({
    enabled: z.boolean(),
    startTime: z.string().regex(TIME_PATTERN, "Use HH:mm."),
    endTime: z.string().regex(TIME_PATTERN, "Use HH:mm."),
  })
  .refine((value) => value.startTime !== value.endTime, {
    path: ["endTime"],
    message: "End time must differ from start time.",
  });

type FormValues = z.infer<typeof formSchema>;

export default function CompileWindowSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);
  const { data: persisted, isFetching: isReading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getCompileWindowSettings,
    refetchOnMount: "always",
  });
  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    initialValues: {
      enabled: false,
      startTime: "23:00",
      endTime: "07:00",
    },
  });

  useEffect(() => {
    if (!persisted || form.isDirty()) return;
    const values: FormValues = {
      enabled: persisted.enabled,
      startTime: persisted.startTime,
      endTime: persisted.endTime,
    };
    form.setValues(values);
    form.resetDirty(values);
  }, [persisted]);

  const handleSubmit = async (values: FormValues) => {
    setIsSaving(true);
    try {
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      const updated = await updateCompileWindowSettings(values);
      form.resetDirty(values);
      queryClient.setQueryData(QUERY_KEY, updated);
      notifications.show({ message: t("Updated successfully") });
    } catch (error: any) {
      notifyError(error, "Failed to update data");
    } finally {
      setIsSaving(false);
    }
  };

  // Clickable hour/minute lists; typing is still allowed.
  const timePickerProps = {
    withDropdown: true,
    format: "24h" as const,
    minutesStep: 5,
    hoursInputLabel: t("Hours"),
    minutesInputLabel: t("Minutes"),
    disabled: isReading,
  };

  return (
    <form onSubmit={form.onSubmit(handleSubmit)}>
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <div>
            <Text size="md">{t("Night compile window")}</Text>
            <Text size="sm" c="dimmed">
              {t(
                "When enabled, automatic and space-level knowledge compilation only runs inside this time window. Manual page publish, retrying failed pages and force rebuild still run immediately.",
              )}
            </Text>
          </div>
          <Switch
            aria-label={t("Night compile window")}
            disabled={isReading}
            {...form.getInputProps("enabled", { type: "checkbox" })}
          />
        </Group>

        {form.values.enabled && (
          <>
            <Group grow align="flex-start">
              <TimePicker
                label={t("Start time")}
                name="startTime"
                {...timePickerProps}
                {...form.getInputProps("startTime")}
              />
              <TimePicker
                label={t("End time")}
                name="endTime"
                {...timePickerProps}
                {...form.getInputProps("endTime")}
              />
            </Group>
            <Text size="xs" c="dimmed">
              {persisted?.serverTimezone
                ? t(
                    "Times follow the server timezone ({{timezone}}). An end time earlier than the start time crosses midnight.",
                    { timezone: persisted.serverTimezone },
                  )
                : t(
                    "An end time earlier than the start time crosses midnight.",
                  )}
            </Text>
          </>
        )}

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
