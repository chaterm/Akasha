import { KnowledgeCompilerLlmError } from '../compiler/knowledge-compiler-llm.provider';

/**
 * Job-level retries are reserved for transient failures of the LLM upstream.
 *
 * Deterministic failures (schema violations, lease conflicts, programming
 * errors) can never succeed on a later attempt, so retrying them only burns the
 * attempts budget and buries the root cause behind retry exhaustion.
 */
export function isRetryableLlmUpstreamError(error: unknown): boolean {
  return error instanceof KnowledgeCompilerLlmError && error.retryable;
}
