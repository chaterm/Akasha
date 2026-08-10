import api from "@/lib/api-client";
import type {
  AiModelConfigFeature,
  AiModelConfigView,
  UpdateAiModelConfigInput,
} from "@/ee/ai/types/ai-model-config.types";

export async function getAiModelConfigs(): Promise<AiModelConfigView[]> {
  const req = await api.get<{ configs: AiModelConfigView[] }>(
    "/llm-wiki/admin/model-configs",
  );
  return req.data.configs;
}

export async function updateAiModelConfig(
  feature: AiModelConfigFeature,
  input: UpdateAiModelConfigInput,
): Promise<AiModelConfigView> {
  const req = await api.put<AiModelConfigView>(
    `/llm-wiki/admin/model-configs/${feature}`,
    input,
  );
  return req.data;
}
