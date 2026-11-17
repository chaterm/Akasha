export type AiModelConfigFeature =
  | "compiler"
  | "answer"
  | "image"
  | "embedding";

export type AiModelProvider = "openai-compatible";

export type ThinkingMode = "qwen" | "openai";

export type ReasoningEffort = "low" | "medium" | "high";

export interface AiModelConfigParameters {
  dimension?: number;
  supportsMrl?: boolean;
  temperature?: number;
  topP?: number;
  seed?: number;
  thinkingMode?: ThinkingMode;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
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
  apiKey?: string;
  parameters?: AiModelConfigParameters;
}

export interface TestAiModelConfigResult {
  ok: boolean;
  code?: string;
  message?: string;
  latencyMs?: number;
}
