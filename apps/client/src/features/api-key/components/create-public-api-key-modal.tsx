import {
  Modal,
  TextInput,
  Button,
  Group,
  Stack,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { z } from "zod/v4";
import { useTranslation } from "react-i18next";
import {
  useCreatePublicApiKeyMutation,
} from "@/features/api-key/queries/api-key-query";
import { IApiKey } from "@/features/api-key";

interface CreatePublicApiKeyModalProps {
  opened: boolean;
  onClose: () => void;
  onSuccess: (response: IApiKey) => void;
}

const schema = z.object({
  name: z.string().min(1),
});

type FormValues = z.infer<typeof schema>;

export function CreatePublicApiKeyModal({
  opened,
  onClose,
  onSuccess,
}: CreatePublicApiKeyModalProps) {
  const { t } = useTranslation();
  const mutation = useCreatePublicApiKeyMutation();
  const form = useForm<FormValues>({
    validate: zod4Resolver(schema),
    initialValues: { name: "" },
  });


  const close = () => {
    form.reset();
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={t("Create Agent")}
      size="md"
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      <form
        onSubmit={form.onSubmit(async (values) => {
          const created = await mutation.mutateAsync({
            name: values.name,
          });
          onSuccess(created);
          close();
        })}
      >
        <Stack gap="md">
          <TextInput
            label={t("Name")}
            placeholder={t("Enter a descriptive name")}
            required
            {...form.getInputProps("name")}
          />
          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={close}>
              {t("Cancel")}
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {t("Create")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
