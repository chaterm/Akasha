const TEXT_WRAPPER_START_RE = /^\s*\{\s*"text"\s*:\s*"/u;
const TEXT_WRAPPER_END_RE = /"\s*\}\s*$/u;

function decodeJsonString(body: string): string {
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body
      .replace(/\\n/gu, "\n")
      .replace(/\\r/gu, "")
      .replace(/\\t/gu, "  ")
      .replace(/\\"/gu, '"')
      .replace(/\\\\/gu, "\\");
  }
}

/**
 * Models occasionally answer with a serialized envelope such as
 * {"text": "..."} instead of plain markdown. Unwrap it so the answer renders
 * as text, while keeping partially streamed payloads readable.
 */
export function stripAiTextWrapper(raw: string): string {
  if (!TEXT_WRAPPER_START_RE.test(raw)) return raw;

  return decodeJsonString(
    raw.replace(TEXT_WRAPPER_START_RE, "").replace(TEXT_WRAPPER_END_RE, ""),
  );
}
