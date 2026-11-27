import {
  Group,
  Box,
  Button,
  TextInput,
  Stack,
  Textarea,
  Text,
} from "@mantine/core";
import React from "react";
import { useForm } from "@mantine/form";
import { modals } from "@mantine/modals";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { z } from "zod/v4";
import { useUpdateSpaceMutation } from "@/features/space/queries/space-query.ts";
import { ISpace } from "@/features/space/types/space.types.ts";
import { useTranslation } from "react-i18next";

const formSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500),
  slug: z
    .string()
    .min(2)
    .max(100)
    .regex(
      /^[a-zA-Z0-9]+$/,
      "Space slug must be alphanumeric. No special characters",
    ),
});

type FormValues = z.infer<typeof formSchema>;
const validateForm = zod4Resolver(formSchema);
interface EditSpaceFormProps {
  space: ISpace;
}
export function EditSpaceForm({ space }: EditSpaceFormProps) {
  const { t } = useTranslation();
  const updateSpaceMutation = useUpdateSpaceMutation();
  const permissions = space.metadataPermissions;

  const form = useForm<FormValues>({
    validate: (values) => {
      const errors = validateForm(values);
      return {
        name: permissions?.name ? errors.name : null,
        slug: permissions?.slug ? errors.slug : null,
        description: permissions?.description ? errors.description : null,
      };
    },
    initialValues: {
      name: space?.name,
      description: space?.description || "",
      slug: space.slug,
    },
  });

  const editableFields = (["name", "slug", "description"] as const).filter(
    (field) => permissions?.[field],
  );
  const changedFields = editableFields.filter((field) => form.isDirty(field));
  const handleSubmit = (values: FormValues) => {
    if (!changedFields.length) return;
    const spaceData: Partial<ISpace> = { spaceId: space.id };
    for (const field of changedFields) {
      spaceData[field] = values[field];
    }
    const save = () =>
      updateSpaceMutation.mutate(spaceData, {
        onSuccess: () => form.resetDirty(values),
      });
    if (spaceData.slug !== undefined) {
      modals.openConfirmModal({
        title: t("Change space identifier"),
        children: (
          <Text size="sm">
            {t(
              "Changing the identifier changes the space link. Existing links may stop working.",
            )}
          </Text>
        ),
        labels: { confirm: t("Save"), cancel: t("Cancel") },
        onConfirm: save,
      });
    } else {
      save();
    }
  };

  return (
    <>
      <Box>
        <form onSubmit={form.onSubmit((values) => handleSubmit(values))}>
          <Stack>
            <TextInput
              id="name"
              label={t("Name")}
              placeholder={t("e.g Sales")}
              variant="filled"
              readOnly={!permissions?.name}
              {...form.getInputProps("name")}
            />

            <TextInput
              id="slug"
              label={t("Slug")}
              variant="filled"
              readOnly={!permissions?.slug}
              {...form.getInputProps("slug")}
            />

            <Textarea
              id="description"
              label={t("Description")}
              placeholder={t("e.g Space for sales team to collaborate")}
              variant="filled"
              readOnly={!permissions?.description}
              autosize
              minRows={1}
              maxRows={3}
              {...form.getInputProps("description")}
            />
          </Stack>

          {editableFields.length > 0 && (
            <Group justify="flex-end" mt="md">
              <Button
                type="submit"
                disabled={!changedFields.length}
                loading={updateSpaceMutation.isPending}
              >
                {t("Save")}
              </Button>
            </Group>
          )}
        </form>
      </Box>
    </>
  );
}
