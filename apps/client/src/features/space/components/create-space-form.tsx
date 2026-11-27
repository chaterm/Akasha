import {
  Group,
  Box,
  Button,
  TextInput,
  Stack,
  Textarea,
  Text,
} from "@mantine/core";
import React, { useEffect } from "react";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { z } from "zod/v4";
import { useNavigate } from "react-router-dom";
import { useCreateSpaceMutation } from "@/features/space/queries/space-query.ts";
import { computeSpaceSlug } from "@/lib";
import { getSpaceUrl } from "@/lib/config.ts";
import { useTranslation } from "react-i18next";
import { SpaceType } from "@/features/space/types/space.types";

const formSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .regex(
      /^[a-zA-Z0-9]+$/,
      "Space slug must be alphanumeric. No special characters",
    ),
  description: z.string().max(500),
});
type FormValues = z.infer<typeof formSchema>;

export function CreateSpaceForm({ type }: { type: SpaceType }) {
  const { t } = useTranslation();
  const isPrivate = type === "personal";
  const createSpaceMutation = useCreateSpaceMutation();
  const navigate = useNavigate();

  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    validateInputOnChange: ["slug"],
    initialValues: {
      name: "",
      slug: "",
      description: "",
    },
  });

  useEffect(() => {
    const name = form.values.name;
    const words = name.trim().split(/\s+/);

    const lastChar = name[name.length - 1];
    const lastWordIsIncomplete =
      words.length > 1 && words[words.length - 1].length === 1;

    if (lastChar !== " " || lastWordIsIncomplete) {
      const slug = computeSpaceSlug(name);
      form.setFieldValue("slug", slug);
    }
  }, [form.values.name]);

  const handleSubmit = async (data: FormValues) => {
    const spaceData = {
      name: data.name,
      slug: data.slug,
      description: data.description,
      type,
    };

    const createdSpace = await createSpaceMutation.mutateAsync(spaceData);
    navigate(getSpaceUrl(createdSpace.slug));
  };

  function handleValidationFailure(errors: Record<string, unknown>) {
    const firstInvalidId = Object.keys(errors)[0];
    if (firstInvalidId) {
      document.getElementById(firstInvalidId)?.focus();
    }
  }

  return (
    <>
      <Box w="100%">
        <form
          onSubmit={form.onSubmit(
            (values) => handleSubmit(values),
            handleValidationFailure,
          )}
        >
          <Text size="sm" c="dimmed" mb="sm">
            {t("* indicates required fields")}
          </Text>
          <Stack>
            <TextInput
              withAsterisk
              id="name"
              w="100%"
              label={t("Space name")}
              placeholder={
                isPrivate ? t("e.g Reading notes") : t("e.g Product Team")
              }
              variant="filled"
              data-autofocus
              errorProps={{ role: "alert" }}
              {...form.getInputProps("name")}
            />

            <TextInput
              withAsterisk
              id="slug"
              w="100%"
              label={t("Space slug")}
              placeholder={isPrivate ? t("e.g readingnotes") : t("e.g product")}
              variant="filled"
              errorProps={{ role: "alert" }}
              {...form.getInputProps("slug")}
            />

            <Textarea
              id="description"
              w="100%"
              label={t("Space description")}
              placeholder={
                isPrivate
                  ? t("e.g A place for reading notes and excerpts")
                  : t("e.g Space for product team")
              }
              variant="filled"
              autosize
              minRows={2}
              maxRows={8}
              errorProps={{ role: "alert" }}
              {...form.getInputProps("description")}
            />
          </Stack>

          <Group justify="flex-end" mt="md">
            <Button type="submit" loading={createSpaceMutation.isPending}>
              {t("Create")}
            </Button>
          </Group>
        </form>
      </Box>
    </>
  );
}
