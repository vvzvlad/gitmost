import { SpaceAppearancePicker } from "./space-appearance-picker";
import {
  Group,
  Box,
  Button,
  TextInput,
  Stack,
  Textarea,
  Divider,
  Switch,
} from "@mantine/core";
import React, { useState } from "react";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { z } from "zod/v4";
import { useUpdateSpaceMutation } from "@/features/space/queries/space-query.ts";
import { ISpace } from "@/features/space/types/space.types.ts";
import { useTranslation } from "react-i18next";
import { isGitSyncEnabled } from "@/lib/config.ts";

const formSchema = z.object({
  icon: z.string().max(40),
  iconColor: z
    .string()
    .regex(/^$|^#[0-9a-fA-F]{6}$/, "Use a six-digit HEX color"),
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
interface EditSpaceFormProps {
  space: ISpace;
  readOnly?: boolean;
}
export function EditSpaceForm({ space, readOnly }: EditSpaceFormProps) {
  const { t } = useTranslation();
  const updateSpaceMutation = useUpdateSpaceMutation();

  const [gitSyncEnabled, setGitSyncEnabled] = useState<boolean>(
    space?.settings?.gitSync?.enabled ?? false,
  );

  // Handler for the git-sync space toggle. The update is optimistic and reverts
  // the local state on failure (the mutation surfaces a toast via onError; the
  // raw error is still logged per AGENTS.md).
  const handleToggle = async (
    field: "gitSyncEnabled",
    value: boolean,
    previous: boolean,
    setLocal: (next: boolean) => void,
    errorLabel: string,
  ) => {
    setLocal(value); // optimistic update
    try {
      await updateSpaceMutation.mutateAsync({
        spaceId: space.id,
        [field]: value,
      });
    } catch (err) {
      setLocal(previous); // revert on failure
      console.error(errorLabel, err);
    }
  };

  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    initialValues: {
      icon: space.settings?.appearance?.icon ?? "",
      iconColor: space.settings?.appearance?.color ?? "",
      name: space?.name,
      description: space?.description || "",
      slug: space.slug,
    },
  });

  const handleSubmit = async (values: FormValues) => {
    if (readOnly) return;
    const spaceData: Partial<ISpace> = {
      spaceId: space.id,
    };
    if (form.isDirty("name")) {
      spaceData.name = values.name;
    }
    if (form.isDirty("description")) {
      spaceData.description = values.description;
    }

    if (form.isDirty("slug")) {
      spaceData.slug = values.slug;
    }

    if (form.isDirty("icon")) spaceData.icon = values.icon || null;
    if (form.isDirty("iconColor"))
      spaceData.iconColor = values.iconColor || null;
    await updateSpaceMutation.mutateAsync(spaceData);
    form.resetDirty();
  };

  return (
    <>
      <Box>
        <form onSubmit={form.onSubmit((values) => handleSubmit(values))}>
          <Stack>
            <SpaceAppearancePicker
              name={form.values.name}
              logo={space.logo}
              icon={form.values.icon}
              color={form.values.iconColor}
              onIconChange={(value) => form.setFieldValue("icon", value)}
              onColorChange={(value) => form.setFieldValue("iconColor", value)}
              readOnly={readOnly}
              error={
                form.errors.iconColor
                  ? t("Use a six-digit HEX color")
                  : undefined
              }
            />
            <TextInput
              id="name"
              label={t("Name")}
              placeholder={t("e.g Sales")}
              variant="filled"
              readOnly={readOnly}
              {...form.getInputProps("name")}
            />

            <TextInput
              id="slug"
              label={t("Slug")}
              variant="filled"
              readOnly={readOnly}
              {...form.getInputProps("slug")}
            />

            <Textarea
              id="description"
              label={t("Description")}
              placeholder={t("e.g Space for sales team to collaborate")}
              variant="filled"
              readOnly={readOnly}
              autosize
              minRows={1}
              maxRows={3}
              {...form.getInputProps("description")}
            />
          </Stack>

          {!readOnly && (
            <Group justify="flex-end" mt="md">
              <Button
                type="submit"
                loading={updateSpaceMutation.isPending}
                disabled={!form.isDirty()}
              >
                {t("Save")}
              </Button>
            </Group>
          )}
        </form>

        {isGitSyncEnabled() && (
          <>
            <Divider my="lg" />

            <Switch
              label={t("Enable Git sync")}
              description={t("Sync this space's pages to a Git repository.")}
              checked={gitSyncEnabled}
              disabled={readOnly || updateSpaceMutation.isPending}
              onChange={(event) =>
                handleToggle(
                  "gitSyncEnabled",
                  event.currentTarget.checked,
                  gitSyncEnabled,
                  setGitSyncEnabled,
                  "Failed to toggle git-sync for space",
                )
              }
            />
          </>
        )}
      </Box>
    </>
  );
}
