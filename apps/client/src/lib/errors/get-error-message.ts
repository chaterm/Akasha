import i18n from "i18next";
import { parseApiError, type ErrorParams } from "./api-error";
import {
  ERROR_CODE_MESSAGES,
  NETWORK_ERROR_MESSAGE,
  STATUS_MESSAGES,
} from "./error-messages";

export interface ErrorMessageOptions {
  withDetail?: boolean;
}

function translate(key: string, params?: ErrorParams): string {
  if (i18n.isInitialized) return i18n.t(key, params);
  return key.replace(/\{\{(\w+)\}\}/g, (placeholder, name) =>
    params?.[name] !== undefined ? String(params[name]) : placeholder,
  );
}

export function getErrorMessage(
  error: unknown,
  fallback: string,
  options: ErrorMessageOptions = {},
): string {
  const info = parseApiError(error);
  const codeMessage = info.code ? ERROR_CODE_MESSAGES[info.code] : undefined;
  if (codeMessage) return translate(codeMessage, info.params);

  const summary = info.network
    ? translate(NETWORK_ERROR_MESSAGE)
    : info.status && STATUS_MESSAGES[info.status]
      ? translate(STATUS_MESSAGES[info.status])
      : translate(fallback);

  if (info.message) {
    console.warn("[api-error]", info.status ?? "", info.code ?? "", info.message);
    if (options.withDetail) {
      return translate("{{summary}}: {{detail}}", {
        summary,
        detail: info.message,
      });
    }
  }
  return summary;
}
