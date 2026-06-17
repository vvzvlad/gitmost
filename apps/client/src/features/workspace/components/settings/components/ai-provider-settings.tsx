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
  useReindexAiEmbeddingsMutation,
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
  // Embedding-specific base URL. Empty means "use the chat base URL".
  embeddingBaseUrl: z.string(),
  systemPrompt: z.string(),
  // Write-only key buffer. Empty string means "do not change" (unless explicitly cleared).
  apiKey: z.string(),
  // Write-only embedding key buffer. Same semantics as `apiKey`.
  embeddingApiKey: z.string(),
});

type FormValues = z.infer<typeof formSchema>;

export default function AiProviderSettings() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();

  // Only admins may read the (masked) AI settings; the server enforces this too.
  const { data: settings, isLoading } = useAiSettingsQuery(isAdmin);
  const updateMutation = useUpdateAiSettingsMutation();
  const testMutation = useTestAiConnectionMutation();
  const reindexMutation = useReindexAiEmbeddingsMutation();

  // Whether a key is currently stored server-side (drives the placeholder).
  const [hasApiKey, setHasApiKey] = useState(false);
  // Tracks whether the user explicitly cleared the stored key.
  const [keyCleared, setKeyCleared] = useState(false);
  // Same, for the embedding-specific key.
  const [hasEmbeddingApiKey, setHasEmbeddingApiKey] = useState(false);
  const [embeddingKeyCleared, setEmbeddingKeyCleared] = useState(false);

  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    initialValues: {
      driver: "openai",
      chatModel: "",
      embeddingModel: "",
      baseUrl: "",
      embeddingBaseUrl: "",
      systemPrompt: "",
      apiKey: "",
      embeddingApiKey: "",
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
      embeddingBaseUrl: settings.embeddingBaseUrl ?? "",
      systemPrompt: settings.systemPrompt ?? "",
      apiKey: "",
      embeddingApiKey: "",
    });
    form.resetDirty();
    setHasApiKey(settings.hasApiKey);
    setKeyCleared(false);
    setHasEmbeddingApiKey(settings.hasEmbeddingApiKey);
    setEmbeddingKeyCleared(false);
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
      // Send the base URLs only for providers that use them. The embedding base
      // URL is optional; empty falls back to the chat base URL server-side.
      baseUrl: showBaseUrl ? values.baseUrl : "",
      embeddingBaseUrl: showBaseUrl ? values.embeddingBaseUrl : "",
      systemPrompt: values.systemPrompt,
    };

    // Key semantics (never send the stored key back):
    //   - typed a value -> set it
    //   - explicitly cleared -> send '' to clear
    //   - untouched -> omit the key entirely (leave unchanged)
    if (showApiKey) {
      if (values.apiKey.length > 0) {
        payload.apiKey = values.apiKey;
      } else if (keyCleared) {
        payload.apiKey = "";
      }

      // Same write-only semantics for the embedding-specific key.
      if (values.embeddingApiKey.length > 0) {
        payload.embeddingApiKey = values.embeddingApiKey;
      } else if (embeddingKeyCleared) {
        payload.embeddingApiKey = "";
      }
    }

    return payload;
  }

  async function handleSubmit(values: FormValues) {
    const updated = await updateMutation.mutateAsync(buildPayload(values));
    // Reflect the new key state and reset the write-only buffers.
    setHasApiKey(updated.hasApiKey);
    setKeyCleared(false);
    form.setFieldValue("apiKey", "");
    setHasEmbeddingApiKey(updated.hasEmbeddingApiKey);
    setEmbeddingKeyCleared(false);
    form.setFieldValue("embeddingApiKey", "");
    form.resetDirty();
  }

  function handleClearKey() {
    setKeyCleared(true);
    setHasApiKey(false);
    form.setFieldValue("apiKey", "");
  }

  function handleClearEmbeddingKey() {
    setEmbeddingKeyCleared(true);
    setHasEmbeddingApiKey(false);
    form.setFieldValue("embeddingApiKey", "");
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

      {showBaseUrl && (
        <TextInput
          label={t("Embedding base URL")}
          placeholder={t("Leave empty to use the chat base URL")}
          readOnly={!isAdmin}
          {...form.getInputProps("embeddingBaseUrl")}
        />
      )}

      {showApiKey && (
        <PasswordInput
          label={t("Embedding API key")}
          // Placeholder hints whether a dedicated key is stored and the fallback;
          // the value is never shown.
          placeholder={
            hasEmbeddingApiKey
              ? t("•••• set")
              : t("Leave empty to use the chat API key")
          }
          readOnly={!isAdmin}
          autoComplete="off"
          {...form.getInputProps("embeddingApiKey")}
        />
      )}

      {showApiKey && isAdmin && hasEmbeddingApiKey && (
        <Group justify="flex-start" mt={-8}>
          <Button
            variant="subtle"
            size="compact-sm"
            color="red"
            onClick={handleClearEmbeddingKey}
          >
            {t("Clear key")}
          </Button>
        </Group>
      )}

      {settings && (
        <Group justify="space-between" mt={-8}>
          <Text size="sm" c="dimmed">
            {t("Indexed {{indexed}} of {{total}} pages", {
              indexed: settings.indexedPages ?? 0,
              total: settings.totalPages ?? 0,
            })}
          </Text>
          {isAdmin && (
            <Button
              variant="subtle"
              size="compact-sm"
              onClick={() => reindexMutation.mutate()}
              loading={reindexMutation.isPending}
            >
              {t("Reindex now")}
            </Button>
          )}
        </Group>
      )}

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
