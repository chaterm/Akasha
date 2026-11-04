import {
  useMutation,
  UseMutationResult,
  useQuery,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  generateAiContent,
  generateAiContentStream,
} from "@/features/ai/services/ai-service.ts";
import {
  AiConfigResponse,
  AiContentResponse,
  AiGenerateDto,
  AiStreamChunk,
} from "@/features/ai/types/ai.types.ts";

export function useAiGenerateMutation(): UseMutationResult<
  AiContentResponse,
  Error,
  AiGenerateDto
> {
  return useMutation({
    mutationFn: (data: AiGenerateDto) => generateAiContent(data),
  });
}

interface StreamCallbacks {
  onController?: (controller: AbortController) => void;
  onChunk: (chunk: AiStreamChunk) => void;
  onError?: (error: unknown) => void;
  onComplete?: () => void;
}

export function useAiGenerateStreamMutation(): UseMutationResult<
  AbortController,
  Error,
  AiGenerateDto & StreamCallbacks
> {
  return useMutation({
    mutationFn: ({ onController, onChunk, onError, onComplete, ...data }) =>
      generateAiContentStream(data, onChunk, onError, onComplete, onController),
  });
}
