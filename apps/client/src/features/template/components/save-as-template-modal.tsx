import { useEffect, useState } from "react";
import {
  Anchor,
  Button,
  Group,
  Modal,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useCreateTemplate } from "../api/template-hooks";
import { TemplateAvailability } from "../api/template.types";
import { ALL_SPACES, isAvailabilityEmpty } from "../lib/availability";
import { TemplateAvailabilityPicker } from "./template-availability-picker";

interface SaveAsTemplateModalProps {
  opened: boolean;
  onClose: () => void;
  page: { id: string; title?: string | null; icon?: string | null };
}

/** 页面菜单 → 另存为模板：正文由服务端从页面复制，这里只收集元信息。 */
export function SaveAsTemplateModal({
  opened,
  onClose,
  page,
}: SaveAsTemplateModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const createTemplate = useCreateTemplate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [availability, setAvailability] =
    useState<TemplateAvailability>(ALL_SPACES);

  useEffect(() => {
    if (opened) {
      setTitle(page.title || "");
      setDescription("");
      setAvailability(ALL_SPACES);
    }
  }, [opened, page.title]);

  const invalid = !title.trim() || isAvailabilityEmpty(availability);

  const submit = async () => {
    const tpl = await createTemplate.mutateAsync({
      title: title.trim(),
      description: description.trim() || undefined,
      icon: page.icon || undefined,
      ...availability,
      sourcePageId: page.id,
    });
    onClose();
    notifications.show({
      autoClose: 6000,
      message: (
        <Group gap="xs" wrap="nowrap">
          <Text size="sm">{t("Saved as template")}</Text>
          <Anchor size="sm" onClick={() => navigate(`/templates/${tpl.id}`)}>
            {t("Edit template")}
          </Anchor>
        </Group>
      ),
    });
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t("Save as template")}
      centered
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid) submit().catch(() => undefined);
        }}
      >
        <Stack gap="sm">
          <TextInput
            data-autofocus
            required
            label={t("Template name")}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
          <Textarea
            label={t("Description")}
            autosize
            minRows={2}
            maxRows={4}
            maxLength={1000}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <TemplateAvailabilityPicker
            label={t("Available in")}
            value={availability}
            onChange={setAvailability}
            fullWidth
            showError
          />
          <Group justify="flex-end" mt="xs">
            <Button variant="default" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              disabled={invalid}
              loading={createTemplate.isPending}
            >
              {t("Save")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
