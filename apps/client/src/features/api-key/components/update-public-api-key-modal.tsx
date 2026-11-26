import {
  Button,
  Group,
  Modal,
  MultiSelect,
  Stack,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { z } from "zod/v4";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { IApiKey } from "@/features/api-key";
import {
  useUpdatePublicApiKeyMutation,
  useGetAgentSpacesQuery,
  useUpdateAgentSpacesMutation,
} from "@/features/api-key/queries/api-key-query";

const schema = z.object({
  name: z.string().min(1),
  spaceIds: z.array(z.string()),
});

type FormValues = z.infer<typeof schema>;

interface UpdatePublicApiKeyModalProps {
  opened: boolean;
  onClose: () => void;
  apiKey: IApiKey | null;
}

export function UpdatePublicApiKeyModal({
  opened,
  onClose,
  apiKey,
}: UpdatePublicApiKeyModalProps) {
  const { t } = useTranslation();
  const mutation = useUpdatePublicApiKeyMutation();
  const spacesMutation = useUpdateAgentSpacesMutation();
  const { data: spaces, isLoading: spacesLoading } =
    useGetAgentSpacesQuery(opened);
  const form = useForm<FormValues>({
    validate: zod4Resolver(schema),
    initialValues: { name: "", spaceIds: [] },
  });

  useEffect(() => {
    if (opened && apiKey) {
      form.setValues({
        name: apiKey.name,
        spaceIds: (apiKey.spaces ?? []).map((space) => space.id),
      });
    }
  }, [opened, apiKey]);


  const close = () => {
    form.reset();
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={t("Edit Agent")}
      size="md"
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      <form
        onSubmit={form.onSubmit(async (values) => {
          if (!apiKey) return;
          await mutation.mutateAsync({
            apiKeyId: apiKey.id,
            name: values.name,
          });
          await spacesMutation.mutateAsync({
            apiKeyId: apiKey.id,
            spaceIds: values.spaceIds,
          });
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
          <MultiSelect
            label={t("Bound spaces")}
            placeholder={t("Select spaces")}
            data={(spaces ?? []).map((space) => ({
              value: space.id,
              label: space.name,
            }))}
            searchable
            clearable
            disabled={spacesLoading}
            {...form.getInputProps("spaceIds")}
          />
          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={close}>
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              loading={mutation.isPending || spacesMutation.isPending}
            >
              {t("Update")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
