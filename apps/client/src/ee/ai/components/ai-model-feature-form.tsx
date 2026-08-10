import {
  Button,
  Group,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { updateAiModelConfig } from "@/ee/ai/services/ai-model-config-service.ts";
import type {
  AiModelConfigFeature,
  AiModelConfigView,
  AiModelProvider,
  UpdateAiModelConfigInput,
} from "@/ee/ai/types/ai-model-config.types.ts";

const PROVIDER_OPTIONS: { value: AiModelProvider; label: string }[] = [
  { value: "openai-compatible", label: "Qwen / OpenAI 兼容" },
];

interface FormValues {
  provider: AiModelProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  dimension: number | "";
  supportsMrl: boolean;
}

function useFeatureCopy(feature: AiModelConfigFeature): {
  title: string;
  description: string;
} {
  const { t } = useTranslation();
  switch (feature) {
    case "compiler":
      return {
        title: t("Knowledge compiler"),
        description: t("Model that compiles pages into structured knowledge."),
      };
    case "answer":
      return {
        title: t("AI chat / answering"),
        description: t("Model that answers questions over your knowledge."),
      };
    case "image":
      return {
        title: t("Image understanding"),
        description: t("Multimodal model for OCR and image captions."),
      };
    case "embedding":
      return {
        title: t("Embedding"),
        description: t("Model that vectorizes text for retrieval."),
      };
  }
}

export default function AiModelFeatureForm({
  config,
}: {
  config: AiModelConfigView;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);
  const copy = useFeatureCopy(config.feature);

  const form = useForm<FormValues>({
    initialValues: {
      provider: config.provider ?? "openai-compatible",
      model: config.model ?? "",
      baseUrl: config.baseUrl ?? "",
      apiKey: "",
      dimension:
        typeof config.parameters?.dimension === "number"
          ? config.parameters.dimension
          : "",
      supportsMrl: config.parameters?.supportsMrl === true,
    },
    validate: {
      model: (value) =>
        value.trim().length === 0 ? t("Model is required") : null,
    },
  });

  const handleSubmit = async (values: FormValues) => {
    setIsSaving(true);
    try {
      const input: UpdateAiModelConfigInput = {
        provider: values.provider,
        model: values.model.trim(),
        baseUrl: values.baseUrl.trim() || undefined,
        parameters: buildParameters(config.feature, values),
      };
      // Only send apiKey when the admin typed a new one, so a blank field
      // preserves the stored key rather than clearing it.
      if (values.apiKey.length > 0) {
        input.apiKey = values.apiKey;
      }

      const saved = await updateAiModelConfig(config.feature, input);
      queryClient.setQueryData<AiModelConfigView[]>(
        ["ai-model-configs"],
        (prev) =>
          prev?.map((item) =>
            item.feature === saved.feature ? saved : item,
          ) ?? prev,
      );
      form.setFieldValue("apiKey", "");
      form.resetDirty();
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
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          {copy.description}
        </Text>

        <Select
          label={t("Provider")}
          data={PROVIDER_OPTIONS}
          allowDeselect={false}
          {...form.getInputProps("provider")}
        />

        <TextInput
          label={t("Model")}
          placeholder="qwen3.8-max"
          {...form.getInputProps("model")}
        />

        <TextInput
          label={t("Base URL")}
          placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
          {...form.getInputProps("baseUrl")}
        />

        <TextInput
          label={t("API key")}
          type="password"
          placeholder={
            config.apiKeySet
              ? t("Saved. Leave blank to keep the current key.")
              : t("Enter the provider API key")
          }
          {...form.getInputProps("apiKey")}
        />

        {config.feature === "embedding" && (
          <Group grow align="flex-start">
            <NumberInput
              label={t("Dimension")}
              placeholder="1024"
              min={1}
              {...form.getInputProps("dimension")}
            />
            <Switch
              mt="xl"
              label={t("Supports MRL")}
              {...form.getInputProps("supportsMrl", { type: "checkbox" })}
            />
          </Group>
        )}

        <Button
          type="submit"
          loading={isSaving}
          disabled={isSaving || !form.isDirty()}
          style={{ alignSelf: "flex-start" }}
        >
          {t("Save")}
        </Button>
      </Stack>
    </form>
  );
}

function buildParameters(
  feature: AiModelConfigFeature,
  values: FormValues,
): UpdateAiModelConfigInput["parameters"] {
  if (feature === "embedding") {
    return {
      ...(typeof values.dimension === "number"
        ? { dimension: values.dimension }
        : {}),
      supportsMrl: values.supportsMrl,
    };
  }
  return undefined;
}
