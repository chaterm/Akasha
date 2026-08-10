import { Alert, Loader, Stack, Tabs, Text } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getAiModelConfigs } from "@/ee/ai/services/ai-model-config-service.ts";
import type { AiModelConfigFeature } from "@/ee/ai/types/ai-model-config.types.ts";
import AiModelFeatureForm from "@/ee/ai/components/ai-model-feature-form.tsx";

const FEATURE_ORDER: AiModelConfigFeature[] = [
  "compiler",
  "answer",
  "image",
  "embedding",
];

export default function AiModelSettings() {
  const { t } = useTranslation();
  const [activeFeature, setActiveFeature] =
    useState<AiModelConfigFeature>("compiler");
  const { data: configs, isLoading } = useQuery({
    queryKey: ["ai-model-configs"],
    queryFn: getAiModelConfigs,
    refetchOnMount: "always",
  });

  const featureLabels: Record<AiModelConfigFeature, string> = {
    compiler: t("Knowledge compiler"),
    answer: t("AI chat / answering"),
    image: t("Image understanding"),
    embedding: t("Embedding"),
  };

  return (
    <Stack gap="lg">
      <div>
        <Text size="md">{t("Model configuration")}</Text>
        <Text size="sm" c="dimmed">
          {t(
            "Choose the OpenAI-compatible model used for each AI capability. A capability is unavailable until its database setting is saved.",
          )}
        </Text>
      </div>

      <Alert
        variant="light"
        color="blue"
        icon={<IconInfoCircle />}
        title={t("Changes apply to new requests")}
      >
        {t(
          "Saved settings take effect on subsequent compilations and answers. The API key is stored encrypted and never shown again after saving.",
        )}
      </Alert>

      {isLoading || !configs ? (
        <Loader size="sm" />
      ) : (
        <Tabs
          value={activeFeature}
          onChange={(value) =>
            setActiveFeature((value as AiModelConfigFeature) ?? "compiler")
          }
          orientation="vertical"
          variant="pills"
          color="blue"
        >
          <Tabs.List>
            {FEATURE_ORDER.map((feature) => (
              <Tabs.Tab key={feature} value={feature}>
                {featureLabels[feature]}
              </Tabs.Tab>
            ))}
          </Tabs.List>

          {FEATURE_ORDER.map((feature) => {
            const config = configs.find((item) => item.feature === feature);
            if (!config) {
              return null;
            }
            return (
              <Tabs.Panel key={feature} value={feature} pl="lg">
                <AiModelFeatureForm config={config} />
              </Tabs.Panel>
            );
          })}
        </Tabs>
      )}
    </Stack>
  );
}
