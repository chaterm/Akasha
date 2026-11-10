import { useState } from "react";
import { Button, Menu, Text, TextInput } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconCopy } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

/** Same clipboard API / execCommand fallback as useClipboard, but verify the
 * legacy command's boolean result before reporting success. */
async function copyId(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const previousFocus = document.activeElement as HTMLElement | null;
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    document.body.appendChild(input);
    try {
      input.select();
      if (!document.execCommand("copy")) throw new Error("Copy failed");
    } finally {
      input.remove();
      previousFocus?.focus();
    }
  }
}

export function CopyTemplateId({
  templateId,
  variant = "menu",
}: {
  templateId: string;
  variant?: "menu" | "button";
}) {
  const { t } = useTranslation();
  const [copying, setCopying] = useState(false);
  if (!templateId || templateId === "new") return null;

  const copy = async () => {
    setCopying(true);
    try {
      await copyId(templateId);
      notifications.show({ message: t("Template ID copied") });
    } catch {
      // Open outside the dropdown so closing the menu cannot hide the fallback.
      modals.open({
        title: t("Copy template ID"),
        children: (
          <>
            <Text size="sm" mb="md" role="alert">
              {t(
                "Could not copy template ID. Select the ID below and copy it manually.",
              )}
            </Text>
            <TextInput
              label={t("Template ID")}
              value={templateId}
              readOnly
              data-autofocus
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
            />
          </>
        ),
      });
    } finally {
      setCopying(false);
    }
  };

  return variant === "button" ? (
    <Button
      variant="default"
      leftSection={<IconCopy size={16} />}
      loading={copying}
      onClick={copy}
    >
      {t("Copy template ID")}
    </Button>
  ) : (
    <Menu.Item
      leftSection={<IconCopy size={14} />}
      disabled={copying}
      onClick={copy}
    >
      {t("Copy template ID")}
    </Menu.Item>
  );
}
