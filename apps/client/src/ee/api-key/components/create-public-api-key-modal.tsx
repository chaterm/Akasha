import {
  Modal,
  TextInput,
  Button,
  Group,
  Stack,
  Select,
  MultiSelect,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { z } from "zod/v4";
import { useTranslation } from "react-i18next";
import {
  useCreatePublicApiKeyMutation,
  useGetPublicApiKeySpacesQuery,
} from "@/ee/api-key/queries/api-key-query";
import { IApiKey } from "@/ee/api-key";
import { useState } from "react";

interface CreatePublicApiKeyModalProps {
  opened: boolean;
  onClose: () => void;
  onSuccess: (response: IApiKey) => void;
}

const schema = z.object({
  name: z.string().min(1),
  spaceIds: z.array(z.string()).min(1),
  expiresAt: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

export function CreatePublicApiKeyModal({
  opened,
  onClose,
  onSuccess,
}: CreatePublicApiKeyModalProps) {
  const { t } = useTranslation();
  const [expiration, setExpiration] = useState("30");
  const { data: spaces, isLoading: spacesLoading } =
    useGetPublicApiKeySpacesQuery();
  const mutation = useCreatePublicApiKeyMutation();
  const form = useForm<FormValues>({
    validate: zod4Resolver(schema),
    initialValues: { name: "", spaceIds: [], expiresAt: "" },
  });

  const expirationDate = () => {
    if (expiration === "never") return undefined;
    const date = new Date();
    date.setDate(date.getDate() + Number(expiration));
    return date.toISOString();
  };

  const close = () => {
    form.reset();
    setExpiration("30");
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={t("Create Public API key")}
      size="md"
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      <form
        onSubmit={form.onSubmit(async (values) => {
          const created = await mutation.mutateAsync({
            name: values.name,
            spaceIds: values.spaceIds,
            expiresAt: expirationDate(),
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
          <MultiSelect
            label={t("Spaces")}
            placeholder={t("Select spaces")}
            data={(spaces ?? []).map((space) => ({
              value: space.id,
              label: space.name,
            }))}
            searchable
            required
            disabled={spacesLoading}
            {...form.getInputProps("spaceIds")}
          />
          <Select
            label={t("Expiration")}
            data={[
              { value: "30", label: t("30 days") },
              { value: "90", label: t("90 days") },
              { value: "365", label: t("1 year") },
              { value: "never", label: t("No expiration") },
            ]}
            value={expiration}
            onChange={(value) => setExpiration(value ?? "30")}
            allowDeselect={false}
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
