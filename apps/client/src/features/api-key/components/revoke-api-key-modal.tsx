import { Modal, Text, Button, Group, Stack } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { useRevokeApiKeyMutation, useDeleteAgentApiKeyMutation } from "@/features/api-key/queries/api-key-query.ts";
import { IApiKey } from "@/features/api-key";

interface RevokeApiKeyModalProps {
  opened: boolean;
  onClose: () => void;
  apiKey: IApiKey | null;
}

export function RevokeApiKeyModal({
  opened,
  onClose,
  apiKey,
}: RevokeApiKeyModalProps) {
  const { t } = useTranslation();
  const revokeApiKeyMutation = useRevokeApiKeyMutation();
  const deleteAgentMutation = useDeleteAgentApiKeyMutation();

  const handleRevoke = async () => {
    if (!apiKey) return;
    if (apiKey.keyType === "agent") await deleteAgentMutation.mutateAsync({ apiKeyId: apiKey.id });
    else await revokeApiKeyMutation.mutateAsync({ apiKeyId: apiKey.id });
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t("{{action}} {{credential}}", {
        action: apiKey?.keyType === "agent" ? t("Delete") : t("Revoke"),
        credential: apiKey?.keyType === "agent" ? t("Agent") : t("API key"),
      })}
      size="md"
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      <Stack gap="md">
        <Text>
          {t("Are you sure you want to {{action}} this {{credential}}", {
            action: apiKey?.keyType === "agent" ? t("delete") : t("revoke"),
            credential: apiKey?.keyType === "agent" ? t("Agent") : t("API key"),
          })}{" "}
          <strong>{apiKey?.name}</strong>?
        </Text>
        <Text size="sm" c="dimmed">
          {t(
            "This action cannot be undone. Any applications using this API key will stop working.",
          )}
        </Text>

        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            color="red"
            onClick={handleRevoke}
            loading={revokeApiKeyMutation.isPending}
          >
            {apiKey?.keyType === "agent" ? t("Delete") : t("Revoke")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
