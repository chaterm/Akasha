import { notifications } from "@mantine/notifications";
import { getErrorMessage, type ErrorMessageOptions } from "./get-error-message";

export function notifyError(
  error: unknown,
  fallback: string,
  options?: ErrorMessageOptions,
): void {
  notifications.show({
    message: getErrorMessage(error, fallback, options),
    color: "red",
  });
}
