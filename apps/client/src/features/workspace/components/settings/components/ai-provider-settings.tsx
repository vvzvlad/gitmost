import { useEffect, useState } from "react";
import { z } from "zod/v4";
import {
  Anchor,
  Badge,
  Box,
  Button,
  Group,
  Modal,
  Paper,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Tooltip,
  useMantineTheme,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { IconPencil } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role.tsx";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import {
  useAiSettingsQuery,
  useReindexAiEmbeddingsMutation,
  useTestAiConnectionMutation,
  useUpdateAiSettingsMutation,
} from "@/features/workspace/queries/ai-settings-query.ts";
import {
  IAiSettingsUpdate,
  SttApiStyle,
} from "@/features/workspace/services/ai-settings-service.ts";
import AiMcpServers from "./ai-mcp-servers.tsx";

// No driver field: every endpoint is OpenAI-compatible, so the form carries only
// the user-editable fields. `apiKey` / `embeddingApiKey` are write-only buffers
// (empty means "leave unchanged" unless explicitly cleared).
const formSchema = z.object({
  chatModel: z.string(),
  embeddingModel: z.string(),
  baseUrl: z.string(),
  // Embedding-specific base URL. Empty means "use the chat base URL".
  embeddingBaseUrl: z.string(),
  systemPrompt: z.string(),
  apiKey: z.string(),
  embeddingApiKey: z.string(),
  // STT-specific fields. Empty base URL / key fall back to the chat ones.
  sttModel: z.string(),
  sttBaseUrl: z.string(),
  sttApiStyle: z.enum(["multipart", "json"]),
  sttApiKey: z.string(),
});

type FormValues = z.infer<typeof formSchema>;

// Four-state endpoint health shown by the header dot. Derived synchronously
// from the form values + feature toggle — never from a network probe (the
// "Test endpoint" button still surfaces the live probe result as text).
//   "ready"     (green)  — required fields filled AND the feature is ON
//   "configured"(yellow) — required fields filled but the feature is OFF
//   "off"       (gray)   — required fields missing (nothing to enable)
//   "warning"   (orange) — feature is ON but required fields are missing
//                          (a real misconfiguration: it won't work as-is)
type CardStatus = "ready" | "configured" | "off" | "warning";

// Resolve a "Base URL + path" hint defensively: trim a single trailing slash
// off the base, then append the path. Empty base falls back to `fallback`
// (the chat base URL for the embedding/voice endpoints). Purely cosmetic.
function resolveUrl(base: string, path: string, fallback = ""): string {
  const trimmed = (base.trim() || fallback.trim()).replace(/\/$/, "");
  return `${trimmed}${path}`;
}

// Pure + unit-testable. `configured` = the endpoint has the fields it needs
// to work; `enabled` = the workspace feature toggle for this endpoint is ON.
// The "enabled && !configured" case is surfaced as "warning" instead of "off"
// so a misconfiguration (feature on, endpoint not filled) is not hidden.
export function resolveCardStatus(
  configured: boolean,
  enabled: boolean,
): CardStatus {
  if (configured) return enabled ? "ready" : "configured";
  return enabled ? "warning" : "off";
}

// Translate the dot's tooltip label. Kept in one place so all three endpoint
// cards share identical wording.
function cardStatusLabel(status: CardStatus, t: (k: string) => string): string {
  switch (status) {
    case "ready":
      return t("Configured and enabled");
    case "configured":
      return t("Configured but disabled");
    case "warning":
      return t("Enabled but not configured");
    default:
      return t("Not configured");
  }
}

// Small colored dot used in each card header, with a tooltip label so the
// state is readable without relying on color alone (colorblind access).
function StatusDot({ status, label }: { status: CardStatus; label: string }) {
  const theme = useMantineTheme();
  const color =
    status === "ready"
      ? theme.colors.green[6]
      : status === "configured"
        ? theme.colors.yellow[6]
        : status === "warning"
          ? theme.colors.orange[6]
          : theme.colors.gray[5];
  return (
    <Tooltip label={label} position="top" withArrow>
      <Box
        w={9}
        h={9}
        style={{ borderRadius: "50%", background: color, flex: "none" }}
      />
    </Tooltip>
  );
}

export default function AiProviderSettings() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();

  // Only admins may read the (masked) AI settings; the server enforces this too.
  const { data: settings, isLoading } = useAiSettingsQuery(isAdmin);
  const updateMutation = useUpdateAiSettingsMutation();
  const reindexMutation = useReindexAiEmbeddingsMutation();

  // Independent test mutations so each card has its own loading + result.
  const chatTest = useTestAiConnectionMutation();
  const embedTest = useTestAiConnectionMutation();
  const sttTest = useTestAiConnectionMutation();

  // Workspace-level feature toggles live in the card headers.
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const [chatEnabled, setChatEnabled] = useState<boolean>(
    workspace?.settings?.ai?.chat ?? false,
  );
  const [searchEnabled, setSearchEnabled] = useState<boolean>(
    workspace?.settings?.ai?.search ?? false,
  );
  const [dictationEnabled, setDictationEnabled] = useState<boolean>(
    workspace?.settings?.ai?.dictation ?? false,
  );
  const [chatToggleLoading, setChatToggleLoading] = useState(false);
  const [searchToggleLoading, setSearchToggleLoading] = useState(false);
  const [dictationToggleLoading, setDictationToggleLoading] = useState(false);

  // Whether a key is currently stored server-side (drives the placeholder).
  const [hasApiKey, setHasApiKey] = useState(false);
  // Tracks whether the user explicitly cleared the stored key.
  const [keyCleared, setKeyCleared] = useState(false);
  // Same, for the embedding-specific key.
  const [hasEmbeddingApiKey, setHasEmbeddingApiKey] = useState(false);
  const [embeddingKeyCleared, setEmbeddingKeyCleared] = useState(false);
  // Same, for the STT-specific key.
  const [hasSttApiKey, setHasSttApiKey] = useState(false);
  const [sttKeyCleared, setSttKeyCleared] = useState(false);

  // Modal for the (large) system message editor.
  const [promptOpened, promptHandlers] = useDisclosure(false);

  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    initialValues: {
      chatModel: "",
      embeddingModel: "",
      baseUrl: "",
      embeddingBaseUrl: "",
      systemPrompt: "",
      apiKey: "",
      embeddingApiKey: "",
      sttModel: "",
      sttBaseUrl: "",
      sttApiStyle: "multipart" as SttApiStyle,
      sttApiKey: "",
    },
  });

  // Hydrate the form once the masked settings load. We ignore `settings.driver`
  // entirely — the driver is always "openai".
  useEffect(() => {
    if (!settings) return;
    form.setValues({
      chatModel: settings.chatModel ?? "",
      embeddingModel: settings.embeddingModel ?? "",
      baseUrl: settings.baseUrl ?? "",
      embeddingBaseUrl: settings.embeddingBaseUrl ?? "",
      systemPrompt: settings.systemPrompt ?? "",
      apiKey: "",
      embeddingApiKey: "",
      sttModel: settings.sttModel ?? "",
      sttBaseUrl: settings.sttBaseUrl ?? "",
      sttApiStyle: settings.sttApiStyle ?? "multipart",
      sttApiKey: "",
    });
    form.resetDirty();
    setHasApiKey(settings.hasApiKey);
    setKeyCleared(false);
    setHasEmbeddingApiKey(settings.hasEmbeddingApiKey);
    setEmbeddingKeyCleared(false);
    setHasSttApiKey(settings.hasSttApiKey);
    setSttKeyCleared(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  function buildPayload(values: FormValues): IAiSettingsUpdate {
    const payload: IAiSettingsUpdate = {
      // Everything is OpenAI-compatible.
      driver: "openai",
      chatModel: values.chatModel,
      embeddingModel: values.embeddingModel,
      // The embedding base URL is optional; empty falls back to the chat base
      // URL server-side.
      baseUrl: values.baseUrl,
      embeddingBaseUrl: values.embeddingBaseUrl,
      systemPrompt: values.systemPrompt,
      // The STT base URL is optional; empty falls back to the chat base URL
      // server-side.
      sttModel: values.sttModel,
      sttBaseUrl: values.sttBaseUrl,
      sttApiStyle: values.sttApiStyle,
    };

    // Key semantics (never send the stored key back):
    //   - typed a value -> set it
    //   - explicitly cleared -> send '' to clear
    //   - untouched -> omit the key entirely (leave unchanged)
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

    // Same write-only semantics for the STT-specific key.
    if (values.sttApiKey.length > 0) {
      payload.sttApiKey = values.sttApiKey;
    } else if (sttKeyCleared) {
      payload.sttApiKey = "";
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
    setHasSttApiKey(updated.hasSttApiKey);
    setSttKeyCleared(false);
    form.setFieldValue("sttApiKey", "");
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

  function handleClearSttKey() {
    setSttKeyCleared(true);
    setHasSttApiKey(false);
    form.setFieldValue("sttApiKey", "");
  }

  // Optimistic toggle for the "AI chat" feature (settings.ai.chat).
  async function handleToggleChat(value: boolean) {
    setChatToggleLoading(true);
    const previous = chatEnabled;
    setChatEnabled(value);
    try {
      const updated = await updateWorkspace({ aiChat: value });
      setWorkspace({
        ...updated,
        settings: {
          ...updated.settings,
          ai: { ...updated.settings?.ai, chat: value },
        },
      });
      notifications.show({ message: t("Updated successfully") });
    } catch (err) {
      setChatEnabled(previous); // revert on failure
      // Surface the server-side error message (e.g. missing pgvector) instead of
      // a generic fallback, mirroring useUpdateAiSettingsMutation.
      const message = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message;
      notifications.show({
        message: message ?? t("Failed to update data"),
        color: "red",
      });
    } finally {
      setChatToggleLoading(false);
    }
  }

  // Optimistic toggle for the "Semantic search" feature (settings.ai.search).
  // Enabling can fail server-side when pgvector is missing — the error
  // notification surfaces that and we revert.
  async function handleToggleSearch(value: boolean) {
    setSearchToggleLoading(true);
    const previous = searchEnabled;
    setSearchEnabled(value);
    try {
      const updated = await updateWorkspace({ aiSearch: value });
      setWorkspace({
        ...updated,
        settings: {
          ...updated.settings,
          ai: { ...updated.settings?.ai, search: value },
        },
      });
      notifications.show({ message: t("Updated successfully") });
    } catch (err) {
      setSearchEnabled(previous); // revert on failure
      // Surface the server-side error message (e.g. missing pgvector) instead of
      // a generic fallback, mirroring useUpdateAiSettingsMutation.
      const message = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message;
      notifications.show({
        message: message ?? t("Failed to update data"),
        color: "red",
      });
    } finally {
      setSearchToggleLoading(false);
    }
  }

  // Optimistic toggle for the "Voice dictation" feature (settings.ai.dictation).
  async function handleToggleDictation(value: boolean) {
    setDictationToggleLoading(true);
    const previous = dictationEnabled;
    setDictationEnabled(value);
    try {
      const updated = await updateWorkspace({ aiDictation: value });
      setWorkspace({
        ...updated,
        settings: {
          ...updated.settings,
          ai: { ...updated.settings?.ai, dictation: value },
        },
      });
      notifications.show({ message: t("Updated successfully") });
    } catch (err) {
      setDictationEnabled(previous);
      const message = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message;
      notifications.show({
        message: message ?? t("Failed to update data"),
        color: "red",
      });
    } finally {
      setDictationToggleLoading(false);
    }
  }

  // Admins only — match the previous behavior.
  if (!isAdmin) {
    return (
      <Text size="sm" c="dimmed">
        {t("Only workspace admins can manage AI provider settings.")}
      </Text>
    );
  }

  // Per-endpoint "configured" predicate, derived from the LIVE form values
  // (the dot reacts as the admin types). A key is NOT required — local
  // servers (Ollama, speaches) work without one. Embeddings and Voice
  // inherit the chat base URL when their own is empty (see resolveUrl).
  const v = form.values;
  const chatBase = v.baseUrl.trim();
  const chatConfigured = v.chatModel.trim() !== "" && chatBase !== "";
  const embedConfigured =
    v.embeddingModel.trim() !== "" &&
    (v.embeddingBaseUrl.trim() !== "" || chatBase !== "");
  const sttConfigured =
    v.sttModel.trim() !== "" &&
    (v.sttBaseUrl.trim() !== "" || chatBase !== "");

  const chatStatus = resolveCardStatus(chatConfigured, chatEnabled);
  const embedStatus = resolveCardStatus(embedConfigured, searchEnabled);
  const sttStatus = resolveCardStatus(sttConfigured, dictationEnabled);

  const chatResolved = resolveUrl(form.values.baseUrl, "/chat/completions");
  const embedResolved = resolveUrl(
    form.values.embeddingBaseUrl,
    "/embeddings",
    form.values.baseUrl,
  );
  const sttResolved = resolveUrl(
    form.values.sttBaseUrl,
    "/audio/transcriptions",
    form.values.baseUrl,
  );

  const monoFont = "ui-monospace, Menlo, monospace";

  return (
    <Stack mt="sm">
      {/* Section header */}
      <Group justify="space-between" align="center">
        <Text fw={700} size="lg">
          {t("Endpoints")}
        </Text>
        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
          {t("where we fetch models")}
        </Text>
      </Group>
      <Text size="sm" c="dimmed" mt={-8}>
        {t(
          "All endpoints are OpenAI-compatible. Point the Base URL at OpenAI, OpenRouter, a local Ollama, or any self-hosted server.",
        )}
      </Text>

      {/* Card 1 — Chat / LLM (root endpoint) */}
      <Paper withBorder radius="md" p="lg">
        <Group justify="space-between" align="center" wrap="nowrap">
          <Group gap="xs" align="center" wrap="nowrap">
            <StatusDot status={chatStatus} label={cardStatusLabel(chatStatus, t)} />
            <Text fw={600}>{t("Chat / LLM")}</Text>
            <Badge size="sm" variant="light" color="gray">
              {t("root")}
            </Badge>
          </Group>
          <Switch
            label={t("AI chat")}
            labelPosition="left"
            checked={chatEnabled}
            disabled={chatToggleLoading}
            onChange={(e) => handleToggleChat(e.currentTarget.checked)}
          />
        </Group>
        <Text size="xs" c="dimmed" mt={4} mb="md">
          {t(
            "/v1/chat/completions · root endpoint — Embeddings and Voice inherit its URL and key",
          )}
        </Text>

        <Group grow align="flex-start">
          <TextInput
            label={t("Model")}
            disabled={isLoading}
            {...form.getInputProps("chatModel")}
          />
          <Stack gap={4}>
            <PasswordInput
              label={t("API key")}
              placeholder={hasApiKey ? t("•••• set") : ""}
              autoComplete="off"
              {...form.getInputProps("apiKey")}
            />
            {hasApiKey && (
              <Anchor component="button" type="button" c="red" size="xs" onClick={handleClearKey}>
                {t("Clear")}
              </Anchor>
            )}
          </Stack>
        </Group>

        <TextInput
          mt="sm"
          label={t("Base URL")}
          disabled={isLoading}
          {...form.getInputProps("baseUrl")}
        />
        <Text size="xs" c="dimmed" mt={4} style={{ fontFamily: monoFont }} truncate>
          {t("Resolves to {{url}}", { url: chatResolved })}
        </Text>

        <Group mt="md" align="center">
          <Button
            variant="default"
            size="sm"
            loading={chatTest.isPending}
            onClick={() => chatTest.mutate("chat")}
          >
            {t("Test endpoint")}
          </Button>
          {chatTest.data &&
            (chatTest.data.ok ? (
              <Text size="sm" c="green">
                {t("Connection successful")}
              </Text>
            ) : (
              <Text size="sm" c="red">
                {chatTest.data.error || t("Connection failed")}
              </Text>
            ))}
        </Group>

        {/* Footer: system message editor */}
        <Box
          mt="md"
          mx="calc(var(--mantine-spacing-lg) * -1)"
          mb="calc(var(--mantine-spacing-lg) * -1)"
          px="lg"
          py="md"
          style={{
            borderTop: "1px solid var(--mantine-color-default-border)",
            background: "var(--mantine-color-default-hover)",
            borderRadius: "0 0 var(--mantine-radius-md) var(--mantine-radius-md)",
          }}
        >
          <Group justify="space-between" align="center" wrap="nowrap">
            <Stack gap={0}>
              <Text fw={600} size="sm">
                {t("System message")}
              </Text>
              <Text size="xs" c="dimmed">
                {t("shared prompt · safety framework appended automatically")}
              </Text>
            </Stack>
            <Button
              variant="default"
              size="xs"
              leftSection={<IconPencil size={14} />}
              onClick={promptHandlers.open}
            >
              {t("Edit")}
            </Button>
          </Group>
        </Box>
      </Paper>

      {/* Card 2 — Embeddings */}
      <Paper withBorder radius="md" p="lg">
        <Group justify="space-between" align="center" wrap="nowrap">
          <Group gap="xs" align="center" wrap="nowrap">
            <StatusDot status={embedStatus} label={cardStatusLabel(embedStatus, t)} />
            <Text fw={600}>{t("Embeddings")}</Text>
          </Group>
          <Switch
            label={t("Semantic search")}
            labelPosition="left"
            checked={searchEnabled}
            disabled={searchToggleLoading}
            onChange={(e) => handleToggleSearch(e.currentTarget.checked)}
          />
        </Group>
        <Text size="xs" c="dimmed" mt={4} mb="md">
          {t("/v1/embeddings · embeds pages so semantic search can find them")}
        </Text>

        <Group grow align="flex-start">
          <TextInput
            label={t("Model")}
            disabled={isLoading}
            {...form.getInputProps("embeddingModel")}
          />
          <Stack gap={4}>
            <PasswordInput
              label={t("Embedding API key")}
              placeholder={
                hasEmbeddingApiKey
                  ? t("•••• set")
                  : t("Leave empty to use the chat API key")
              }
              autoComplete="off"
              {...form.getInputProps("embeddingApiKey")}
            />
            {hasEmbeddingApiKey && (
              <Anchor
                component="button"
                type="button"
                c="red"
                size="xs"
                onClick={handleClearEmbeddingKey}
              >
                {t("Clear")}
              </Anchor>
            )}
          </Stack>
        </Group>

        <TextInput
          mt="sm"
          label={t("Base URL")}
          placeholder={t("Leave empty to use the chat base URL")}
          disabled={isLoading}
          {...form.getInputProps("embeddingBaseUrl")}
        />
        <Text size="xs" c="dimmed" mt={4} style={{ fontFamily: monoFont }} truncate>
          {t("Resolves to {{url}}", { url: embedResolved })}
        </Text>

        <Group mt="md" align="center">
          <Button
            variant="default"
            size="sm"
            loading={embedTest.isPending}
            onClick={() => embedTest.mutate("embeddings")}
          >
            {t("Test endpoint")}
          </Button>
          {embedTest.data &&
            (embedTest.data.ok ? (
              <Text size="sm" c="green">
                {t("Connection successful")}
              </Text>
            ) : (
              <Text size="sm" c="red">
                {embedTest.data.error || t("Connection failed")}
              </Text>
            ))}
        </Group>

        {/* Footer: vector search / reindex */}
        <Box
          mt="md"
          mx="calc(var(--mantine-spacing-lg) * -1)"
          mb="calc(var(--mantine-spacing-lg) * -1)"
          px="lg"
          py="md"
          style={{
            borderTop: "1px solid var(--mantine-color-default-border)",
            background: "var(--mantine-color-default-hover)",
            borderRadius: "0 0 var(--mantine-radius-md) var(--mantine-radius-md)",
          }}
        >
          <Text size="xs" c="dimmed" mb="xs">
            {t("Vector search · requires pgvector")}
          </Text>
          <Group justify="space-between" align="center">
            <Text size="sm" c="dimmed">
              {t("Indexed {{indexed}} of {{total}} pages", {
                indexed: settings?.indexedPages ?? 0,
                total: settings?.totalPages ?? 0,
              })}
            </Text>
            <Button
              variant="subtle"
              size="compact-sm"
              loading={reindexMutation.isPending}
              onClick={() => reindexMutation.mutate()}
            >
              {t("Reindex now")}
            </Button>
          </Group>
        </Box>
      </Paper>

      {/* Card 3 — Voice / STT */}
      <Paper withBorder radius="md" p="lg">
        <Group justify="space-between" align="center" wrap="nowrap">
          <Group gap="xs" align="center" wrap="nowrap">
            <StatusDot status={sttStatus} label={cardStatusLabel(sttStatus, t)} />
            <Text fw={600}>{t("Voice / STT")}</Text>
          </Group>
          <Switch
            label={t("Voice dictation")}
            labelPosition="left"
            checked={dictationEnabled}
            disabled={dictationToggleLoading}
            onChange={(e) => handleToggleDictation(e.currentTarget.checked)}
          />
        </Group>
        <Text size="xs" c="dimmed" mt={4} mb="md">
          {t(
            "/v1/audio/transcriptions · works with local whisper (speaches / faster-whisper-server)",
          )}
        </Text>

        <Group grow align="flex-start">
          <TextInput
            label={t("Model")}
            disabled={isLoading}
            {...form.getInputProps("sttModel")}
          />
          <Stack gap={4}>
            <PasswordInput
              label={t("API key")}
              placeholder={
                hasSttApiKey
                  ? t("•••• set")
                  : t("Leave empty to use the chat API key")
              }
              autoComplete="off"
              {...form.getInputProps("sttApiKey")}
            />
            {hasSttApiKey && (
              <Anchor
                component="button"
                type="button"
                c="red"
                size="xs"
                onClick={handleClearSttKey}
              >
                {t("Clear")}
              </Anchor>
            )}
          </Stack>
        </Group>

        <Select
          mt="sm"
          label={t("Request format")}
          description={t("How transcription requests are sent to the endpoint")}
          data={[
            {
              value: "multipart",
              label: t("OpenAI-compatible (multipart/form-data)"),
            },
            { value: "json", label: t("OpenRouter (JSON, base64 audio)") },
          ]}
          allowDeselect={false}
          disabled={isLoading}
          {...form.getInputProps("sttApiStyle")}
        />

        <TextInput
          mt="sm"
          label={t("Base URL")}
          placeholder={t("Leave empty to use the chat base URL")}
          disabled={isLoading}
          {...form.getInputProps("sttBaseUrl")}
        />
        <Text size="xs" c="dimmed" mt={4} style={{ fontFamily: monoFont }} truncate>
          {t("Resolves to {{url}}", { url: sttResolved })}
        </Text>

        <Group mt="md" align="center">
          <Button
            variant="default"
            size="sm"
            loading={sttTest.isPending}
            onClick={() => sttTest.mutate("stt")}
          >
            {t("Test endpoint")}
          </Button>
          {sttTest.data &&
            (sttTest.data.ok ? (
              <Text size="sm" c="green">
                {t("Connection successful")}
              </Text>
            ) : (
              <Text size="sm" c="red">
                {sttTest.data.error || t("Connection failed")}
              </Text>
            ))}
        </Group>
      </Paper>

      {/* Nested: external MCP tools the agent calls out to */}
      <AiMcpServers />

      {/* Save all endpoint settings */}
      <Group>
        <Button
          type="button"
          onClick={() => void handleSubmit(form.values).catch(() => {})}
          disabled={updateMutation.isPending || !form.isValid()}
          loading={updateMutation.isPending}
        >
          {t("Save endpoints")}
        </Button>
      </Group>

      {/* System message editor modal (edits form state; persisted on Save) */}
      <Modal
        opened={promptOpened}
        onClose={promptHandlers.close}
        title={t("System message")}
        size="lg"
      >
        <Stack>
          <Textarea
            autosize
            minRows={6}
            maxRows={20}
            description={t("A built-in safety framework is always appended.")}
            {...form.getInputProps("systemPrompt")}
          />
          <Group justify="flex-end">
            <Button onClick={promptHandlers.close}>{t("Done")}</Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
