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
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { IApiKey } from "@/ee/api-key";
import {
  useGetPublicApiKeySpacesQuery,
  useUpdatePublicApiKeyMutation,
} from "@/ee/api-key/queries/api-key-query";

const schema = z.object({
  name: z.string().min(1),
  spaceIds: z.array(z.string()).min(1),
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
  const { data: spaces, isLoading: spacesLoading } =
    useGetPublicApiKeySpacesQuery();
  const mutation = useUpdatePublicApiKeyMutation();
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

  const spaceOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const space of [...(apiKey?.spaces ?? []), ...(spaces ?? [])]) {
      options.set(space.id, space.name ?? space.id);
    }
    return [...options].map(([value, label]) => ({ value, label }));
  }, [apiKey?.spaces, spaces]);

  const close = () => {
    form.reset();
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={t("Update Public API key")}
      size="md"
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      <form
        onSubmit={form.onSubmit(async (values) => {
          if (!apiKey) return;
          await mutation.mutateAsync({
            apiKeyId: apiKey.id,
            name: values.name,
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
            label={t("Spaces")}
            placeholder={t("Select spaces")}
            data={spaceOptions}
            searchable
            required
            disabled={spacesLoading}
            {...form.getInputProps("spaceIds")}
          />
          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={close}>
              {t("Cancel")}
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {t("Update")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
