import { Button, Divider, Modal, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { CreateSpaceForm } from "@/features/space/components/create-space-form.tsx";
import { useTranslation } from "react-i18next";
import { SpaceType } from "@/features/space/types/space.types";

export default function CreateSpaceModal({ type }: { type: SpaceType }) {
  const { t } = useTranslation();
  const [opened, { open, close }] = useDisclosure(false);
  const title =
    type === "personal" ? t("Create personal space") : t("Create public space");

  return (
    <>
      <Button onClick={open}>{title}</Button>

      <Modal
        opened={opened}
        onClose={close}
        title={title}
        size={520}
        closeButtonProps={{ "aria-label": t("Close") }}
      >
        <Divider size="xs" mb="xs" />
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {type === "personal"
              ? t(
                  "Only you manage your personal space. To create a public knowledge base, contact your workspace owner.",
                )
              : t(
                  "Public spaces are available to workspace members according to their permissions.",
                )}
          </Text>
          <CreateSpaceForm type={type} />
        </Stack>
      </Modal>
    </>
  );
}
