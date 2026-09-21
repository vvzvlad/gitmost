import { Button, Group, Modal, Select, Stack, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useTranslation } from "react-i18next";
import {
  ApiKeyLifetime,
  DEFAULT_LIFETIME,
  lifetimeToExpiresAt,
} from "@/features/api-key/utils";

interface Props {
  opened: boolean;
  onClose: () => void;
  // Resolves the create request, returning true on success. The parent owns the
  // mutation (and the token it returns); this modal only collects the name +
  // lifetime. On failure (false) the form state is kept so the user can retry.
  onSubmit: (values: {
    name: string;
    expiresAt: string | null;
  }) => Promise<boolean>;
  loading?: boolean;
}

interface FormValues {
  name: string;
  lifetime: ApiKeyLifetime;
}

export function CreateApiKeyModal({
  opened,
  onClose,
  onSubmit,
  loading,
}: Props) {
  const { t } = useTranslation();

  const form = useForm<FormValues>({
    initialValues: {
      name: "",
      lifetime: DEFAULT_LIFETIME,
    },
    validate: {
      name: (value) =>
        value.trim().length === 0 ? t("Name is required") : null,
    },
  });

  const lifetimeOptions: { value: ApiKeyLifetime; label: string }[] = [
    { value: "30d", label: t("30 days") },
    { value: "90d", label: t("90 days") },
    { value: "1y", label: t("1 year") },
    { value: "never", label: t("No expiration") },
  ];

  const handleSubmit = form.onSubmit(async (values) => {
    const ok = await onSubmit({
      name: values.name.trim(),
      expiresAt: lifetimeToExpiresAt(values.lifetime),
    });
    // Reset only after a successful submit so a failed create keeps the form
    // state (the parent surfaces the error via a notification).
    if (ok) form.reset();
  });

  const handleClose = () => {
    form.reset();
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={t("Create API key")}
      centered
    >
      <form onSubmit={handleSubmit}>
        <Stack gap="sm">
          <TextInput
            label={t("Name")}
            placeholder={t("e.g. CI deploy token")}
            data-autofocus
            withAsterisk
            {...form.getInputProps("name")}
          />
          <Select
            label={t("Expiration")}
            data={lifetimeOptions}
            allowDeselect={false}
            checkIconPosition="right"
            {...form.getInputProps("lifetime")}
          />
          <Group justify="flex-end" mt="xs">
            <Button variant="default" onClick={handleClose} type="button">
              {t("Cancel")}
            </Button>
            <Button type="submit" loading={loading}>
              {t("Create")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
