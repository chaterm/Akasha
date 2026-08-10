export type AiModelConfigFeature =
  | "compiler"
  | "answer"
  | "image"
  | "embedding";

export type AiModelProvider = "openai-compatible";

export interface AiModelConfigParameters {
  // Embedding tuning.
  dimension?: number;
  supportsMrl?: boolean;
  [key: string]: unknown;
}

export interface AiModelConfigView {
  feature: AiModelConfigFeature;
  provider: AiModelProvider | null;
  model: string | null;
  baseUrl: string | null;
  apiKeySet: boolean;
  parameters: AiModelConfigParameters | null;
}

export interface UpdateAiModelConfigInput {
  provider: AiModelProvider;
  model: string;
  baseUrl?: string;
  // Omit to keep the stored key; any provided value replaces it.
  apiKey?: string;
  parameters?: AiModelConfigParameters;
}
