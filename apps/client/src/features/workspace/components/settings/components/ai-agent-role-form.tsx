import { useEffect } from "react";
import { z } from "zod/v4";
import {
  Button,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { useTranslation } from "react-i18next";
import {
  useCreateAiRoleMutation,
  useUpdateAiRoleMutation,
} from "@/features/ai-chat/queries/ai-chat-query.ts";
import {
  IAiRole,
  IAiRoleCreate,
  IAiRoleUpdate,
} from "@/features/ai-chat/types/ai-chat.types.ts";

// Source of truth: the server `AI_DRIVERS` list in
// apps/server/src/integrations/ai/ai.types.ts. The client cannot import that
// constant at build time (separate build target), so it is mirrored here and a
// drift contract test (ai-agent-role-form.drivers.test.ts) fails if the two
// lists diverge. Keep this in sync when adding/removing a server driver.
export const AI_DRIVER_VALUES = ["openai", "gemini", "ollama"] as const;
export type AiDriverValue = (typeof AI_DRIVER_VALUES)[number];

const DRIVER_LABELS: Record<AiDriverValue, string> = {
  openai: "OpenAI",
  gemini: "Gemini",
  ollama: "Ollama",
};

// Select options for the optional model override. "" => use the workspace
// default driver/model.
export const DRIVER_OPTIONS = [
  { value: "", label: "Workspace default" },
  ...AI_DRIVER_VALUES.map((value) => ({ value, label: DRIVER_LABELS[value] })),
];

const formSchema = z.object({
  name: z.string().min(1),
  emoji: z.string(),
  description: z.string(),
  instructions: z.string().min(1),
  // "" => no driver override (use the workspace driver).
  driver: z.enum(["", ...AI_DRIVER_VALUES]),
  chatModel: z.string(),
  enabled: z.boolean(),
  autoStart: z.boolean(),
  launchMessage: z.string(),
});

type FormValues = z.infer<typeof formSchema>;

interface AiAgentRoleFormProps {
  // When provided, edits an existing role; otherwise creates one.
  role?: IAiRole;
  onClose: () => void;
}

export default function AiAgentRoleForm({
  role,
  onClose,
}: AiAgentRoleFormProps) {
  const { t } = useTranslation();
  const isEdit = Boolean(role);

  const createMutation = useCreateAiRoleMutation();
  const updateMutation = useUpdateAiRoleMutation();

  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    initialValues: {
      name: role?.name ?? "",
      emoji: role?.emoji ?? "",
      description: role?.description ?? "",
      instructions: role?.instructions ?? "",
      driver: (role?.modelConfig?.driver ?? "") as FormValues["driver"],
      chatModel: role?.modelConfig?.chatModel ?? "",
      enabled: role?.enabled ?? true,
      autoStart: role?.autoStart ?? true,
      launchMessage: role?.launchMessage ?? "",
    },
  });

  // Re-hydrate when the target role changes (reusing the modal).
  useEffect(() => {
    form.setValues({
      name: role?.name ?? "",
      emoji: role?.emoji ?? "",
      description: role?.description ?? "",
      instructions: role?.instructions ?? "",
      driver: (role?.modelConfig?.driver ?? "") as FormValues["driver"],
      chatModel: role?.modelConfig?.chatModel ?? "",
      enabled: role?.enabled ?? true,
      autoStart: role?.autoStart ?? true,
      launchMessage: role?.launchMessage ?? "",
    });
    form.resetDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role?.id]);

  // Build the model override payload: null when neither a driver nor a model id
  // is set (use the workspace default).
  function resolveModelConfig(values: FormValues) {
    const driver = values.driver || undefined;
    const chatModel = values.chatModel.trim() || undefined;
    if (!driver && !chatModel) return null;
    return { driver, chatModel };
  }

  async function handleSubmit(values: FormValues) {
    const modelConfig = resolveModelConfig(values);

    if (isEdit && role) {
      const payload: IAiRoleUpdate = {
        id: role.id,
        name: values.name,
        emoji: values.emoji,
        description: values.description,
        instructions: values.instructions,
        modelConfig,
        enabled: values.enabled,
        autoStart: values.autoStart,
        launchMessage: values.launchMessage,
      };
      await updateMutation.mutateAsync(payload);
    } else {
      const payload: IAiRoleCreate = {
        name: values.name,
        emoji: values.emoji || undefined,
        description: values.description || undefined,
        instructions: values.instructions,
        modelConfig,
        enabled: values.enabled,
        autoStart: values.autoStart,
        // Send the raw (trimmed) value like the update path; the server
        // normalizes an empty string to null (emptyToNull). Symmetric.
        launchMessage: values.launchMessage,
      };
      await createMutation.mutateAsync(payload);
    }

    onClose();
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <Stack>
      <TextInput
        label={t("Role name")}
        placeholder={t("e.g. Proofreader")}
        {...form.getInputProps("name")}
      />

      <TextInput
        label={t("Emoji")}
        description={t("Optional. Shown as the chat badge.")}
        maxLength={8}
        {...form.getInputProps("emoji")}
      />

      <TextInput
        label={t("Description")}
        description={t("Optional. A short note about what this role does.")}
        {...form.getInputProps("description")}
      />

      <Textarea
        label={t("Instructions")}
        description={t(
          "The built-in safety framework is always added automatically.",
        )}
        autosize
        minRows={4}
        maxRows={14}
        {...form.getInputProps("instructions")}
      />

      <Group grow align="flex-start">
        <Select
          label={t("Model provider override")}
          description={t("Optional. Defaults to the workspace provider.")}
          data={DRIVER_OPTIONS}
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
          {...form.getInputProps("driver")}
        />
        <TextInput
          label={t("Model override")}
          description={t("Optional. Defaults to the workspace model.")}
          placeholder={t("e.g. gpt-4o-mini")}
          {...form.getInputProps("chatModel")}
        />
      </Group>
      <Text size="xs" c="dimmed" mt={-8}>
        {t(
          "If you choose a different provider, it must already be configured in AI settings.",
        )}
      </Text>

      <Switch
        label={t("Start automatically")}
        description={t(
          "When on, picking this role sends a launch message and starts the chat. When off, the role is selected and you type the first message yourself.",
        )}
        checked={form.values.autoStart}
        onChange={(event) =>
          form.setFieldValue("autoStart", event.currentTarget.checked)
        }
      />

      <Textarea
        label={t("Launch message")}
        description={t(
          "Sent automatically when this role is picked. Leave empty to use the default text. Ignored when “Start automatically” is off.",
        )}
        autosize
        minRows={2}
        maxRows={6}
        {...form.getInputProps("launchMessage")}
      />

      <Switch
        label={t("Enabled")}
        checked={form.values.enabled}
        onChange={(event) =>
          form.setFieldValue("enabled", event.currentTarget.checked)
        }
      />

      <Group justify="flex-end" mt="sm">
        <Button type="button" variant="default" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button
          type="button"
          onClick={() => handleSubmit(form.values)}
          disabled={isSaving || !form.isValid()}
          loading={isSaving}
        >
          {t("Save")}
        </Button>
      </Group>
    </Stack>
  );
}
