import { useEffect, useState } from "react";
import { z } from "zod/v4";
import {
  Alert,
  Button,
  Group,
  PasswordInput,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { IconCheck, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role.tsx";
import {
  useAiSettingsQuery,
  useTestAiConnectionMutation,
  useUpdateAiSettingsMutation,
} from "@/features/workspace/queries/ai-settings-query.ts";
import {
  AiDriver,
  IAiSettingsUpdate,
} from "@/features/workspace/services/ai-settings-service.ts";

const formSchema = z.object({
  driver: z.enum(["openai", "gemini", "ollama"]),
  chatModel: z.string(),
  embeddingModel: z.string(),
  baseUrl: z.string(),
  systemPrompt: z.string(),
  // Write-only key buffer. Empty string means "do not change" (unless explicitly cleared).
  apiKey: z.string(),
});

type FormValues = z.infer<typeof formSchema>;

export default function AiProviderSettings() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();

  // Only admins may read the (masked) AI settings; the server enforces this too.
  const { data: settings, isLoading } = useAiSettingsQuery(isAdmin);
  const updateMutation = useUpdateAiSettingsMutation();
  const testMutation = useTestAiConnectionMutation();

  // Whether a key is currently stored server-side (drives the placeholder).
  const [hasApiKey, setHasApiKey] = useState(false);
  // Tracks whether the user explicitly cleared the stored key.
  const [keyCleared, setKeyCleared] = useState(false);

  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    initialValues: {
      driver: "openai",
      chatModel: "",
      embeddingModel: "",
      baseUrl: "",
      systemPrompt: "",
      apiKey: "",
    },
  });

  // Hydrate the form once the masked settings load.
  useEffect(() => {
    if (!settings) return;
    form.setValues({
      driver: settings.driver ?? "openai",
      chatModel: settings.chatModel ?? "",
      embeddingModel: settings.embeddingModel ?? "",
      baseUrl: settings.baseUrl ?? "",
      systemPrompt: settings.systemPrompt ?? "",
      apiKey: "",
    });
    form.resetDirty();
    setHasApiKey(settings.hasApiKey);
    setKeyCleared(false);
  }, [settings]);

  const driver = form.values.driver as AiDriver;
  // Ollama runs locally and needs no API key.
  const showApiKey = driver === "openai" || driver === "gemini";
  // OpenAI and Ollama accept a custom base URL; Gemini does not.
  const showBaseUrl = driver === "openai" || driver === "ollama";

  function buildPayload(values: FormValues): IAiSettingsUpdate {
    const payload: IAiSettingsUpdate = {
      driver: values.driver,
      chatModel: values.chatModel,
      embeddingModel: values.embeddingModel,
      // Send the base URL only for providers that use it.
      baseUrl: showBaseUrl ? values.baseUrl : "",
      systemPrompt: values.systemPrompt,
    };

    // Key semantics (never send the stored key back):
    //   - typed a value -> set it
    //   - explicitly cleared -> send '' to clear
    //   - untouched -> omit `apiKey` entirely (leave unchanged)
    if (showApiKey) {
      if (values.apiKey.length > 0) {
        payload.apiKey = values.apiKey;
      } else if (keyCleared) {
        payload.apiKey = "";
      }
    }

    return payload;
  }

  async function handleSubmit(values: FormValues) {
    const updated = await updateMutation.mutateAsync(buildPayload(values));
    // Reflect the new key state and reset the write-only buffer.
    setHasApiKey(updated.hasApiKey);
    setKeyCleared(false);
    form.setFieldValue("apiKey", "");
    form.resetDirty();
  }

  function handleClearKey() {
    setKeyCleared(true);
    setHasApiKey(false);
    form.setFieldValue("apiKey", "");
  }

  const driverOptions = [
    { value: "openai", label: "OpenAI" },
    { value: "gemini", label: "Gemini" },
    { value: "ollama", label: "Ollama" },
  ];

  const testResult = testMutation.data;

  return (
    <Stack mt="sm">
      <Select
        label={t("Provider")}
        data={driverOptions}
        allowDeselect={false}
        disabled={!isAdmin || isLoading}
        {...form.getInputProps("driver")}
      />

      {showApiKey && (
        <PasswordInput
          label={t("API key")}
          // Placeholder hints whether a key is already stored; the value is never shown.
          placeholder={hasApiKey ? t("•••• set") : ""}
          readOnly={!isAdmin}
          autoComplete="off"
          {...form.getInputProps("apiKey")}
        />
      )}

      {showApiKey && isAdmin && hasApiKey && (
        <Group justify="flex-start" mt={-8}>
          <Button
            variant="subtle"
            size="compact-sm"
            color="red"
            onClick={handleClearKey}
          >
            {t("Clear key")}
          </Button>
        </Group>
      )}

      {showBaseUrl && (
        <TextInput
          label={t("Base URL")}
          readOnly={!isAdmin}
          {...form.getInputProps("baseUrl")}
        />
      )}

      <TextInput
        label={t("Chat model")}
        readOnly={!isAdmin}
        {...form.getInputProps("chatModel")}
      />

      <TextInput
        label={t("Embedding model")}
        readOnly={!isAdmin}
        {...form.getInputProps("embeddingModel")}
      />

      <Textarea
        label={t("System message")}
        description={t(
          "A built-in safety framework is always appended.",
        )}
        autosize
        minRows={3}
        maxRows={10}
        readOnly={!isAdmin}
        {...form.getInputProps("systemPrompt")}
      />

      {testResult && (
        <Alert
          color={testResult.ok ? "green" : "red"}
          icon={testResult.ok ? <IconCheck size={16} /> : <IconX size={16} />}
        >
          {testResult.ok
            ? t("Connection successful")
            : testResult.error || t("Connection failed")}
        </Alert>
      )}

      {isAdmin && (
        <Group>
          <Button
            type="button"
            onClick={() => handleSubmit(form.values)}
            disabled={updateMutation.isPending || !form.isValid()}
            loading={updateMutation.isPending}
          >
            {t("Save")}
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={() => testMutation.mutate()}
            loading={testMutation.isPending}
          >
            {t("Test connection")}
          </Button>
        </Group>
      )}

      {!isAdmin && (
        <Text size="sm" c="dimmed">
          {t("Only workspace admins can manage AI provider settings.")}
        </Text>
      )}
    </Stack>
  );
}
