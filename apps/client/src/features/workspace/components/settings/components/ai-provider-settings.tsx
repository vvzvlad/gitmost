import { useEffect, useState } from "react";
import { z } from "zod/v4";
import {
  ActionIcon,
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
import { IconPencil, IconX } from "@tabler/icons-react";
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
  AiTestCapability,
  IAiSettingsUpdate,
  SttApiStyle,
  ChatApiStyle,
} from "@/features/workspace/services/ai-settings-service.ts";
import { useAiRolesQuery } from "@/features/ai-chat/queries/ai-chat-query.ts";
import { IAiRole } from "@/features/ai-chat/types/ai-chat.types.ts";
import AiMcpServers from "./ai-mcp-servers.tsx";

// Curated ISO-639-1 dictation languages for the STT card. The empty-value
// "Auto-detect" entry is prepended in render (it needs translation). Values
// are sent verbatim to the transcription model as the language hint.
const STT_LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: "en", label: "English" },
  { value: "ru", label: "Russian — Русский" },
  { value: "uk", label: "Ukrainian — Українська" },
  { value: "de", label: "German — Deutsch" },
  { value: "fr", label: "French — Français" },
  { value: "es", label: "Spanish — Español" },
  { value: "it", label: "Italian — Italiano" },
  { value: "pt", label: "Portuguese — Português" },
  { value: "nl", label: "Dutch — Nederlands" },
  { value: "pl", label: "Polish — Polski" },
  { value: "tr", label: "Turkish — Türkçe" },
  { value: "cs", label: "Czech — Čeština" },
  { value: "sv", label: "Swedish — Svenska" },
  { value: "fi", label: "Finnish — Suomi" },
  { value: "da", label: "Danish — Dansk" },
  { value: "no", label: "Norwegian — Norsk" },
  { value: "ro", label: "Romanian — Română" },
  { value: "hu", label: "Hungarian — Magyar" },
  { value: "el", label: "Greek — Ελληνικά" },
  { value: "he", label: "Hebrew — עברית" },
  { value: "ar", label: "Arabic — العربية" },
  { value: "hi", label: "Hindi — हिन्दी" },
  { value: "id", label: "Indonesian — Bahasa Indonesia" },
  { value: "vi", label: "Vietnamese — Tiếng Việt" },
  { value: "th", label: "Thai — ไทย" },
  { value: "ja", label: "Japanese — 日本語" },
  { value: "ko", label: "Korean — 한국어" },
  { value: "zh", label: "Chinese — 中文" },
];

// No driver field: every endpoint is OpenAI-compatible, so the form carries only
// the user-editable fields. `apiKey` / `embeddingApiKey` are write-only buffers
// (empty means "leave unchanged" unless explicitly cleared).
const formSchema = z.object({
  chatModel: z.string(),
  // Chat provider implementation (reasoning surfacing). Default openai-compatible.
  chatApiStyle: z.enum(["openai-compatible", "openai"]),
  // Cheap model id for the anonymous public-share assistant; empty = use chatModel.
  publicShareChatModel: z.string(),
  // Agent-role id whose persona the public-share assistant adopts; empty =
  // built-in locked persona.
  publicShareAssistantRoleId: z.string(),
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
  // ISO-639-1 dictation language; empty = auto-detect.
  sttLanguage: z.string(),
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

// Pure + unit-testable. A non-chat endpoint (embeddings / voice) is "configured"
// when its model is set AND it has a usable base URL: either its own base URL is
// non-empty, or the chat base URL is non-empty (inherited when own is empty).
// All inputs are trimmed so whitespace-only values do not count as filled.
export function isEndpointConfigured(
  model: string,
  ownBase: string,
  chatBase: string,
): boolean {
  return (
    model.trim() !== "" && (ownBase.trim() !== "" || chatBase.trim() !== "")
  );
}

// Pure + unit-testable. Write-only API-key payload semantics:
//   - typed a value (buffer non-empty) -> set it
//   - explicitly cleared -> send '' to clear the stored key
//   - untouched (empty buffer, not cleared) -> omit the key entirely
export function resolveKeyField(
  buffer: string,
  cleared: boolean,
): { set: true; value: string } | { set: false } {
  if (buffer.length > 0) return { set: true, value: buffer };
  if (cleared) return { set: true, value: "" };
  return { set: false };
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

  // Reindexing runs as an async background job: the endpoint returns the
  // PRE-job counts immediately, so the only way the "Indexed X of Y" counter
  // visibly climbs is to keep polling the settings query while the job runs.
  // `reindexDeadline` is the timestamp until which we poll (set on reindex
  // success); polling stops early once indexed === total. Bounded so a stuck
  // job can never poll forever.
  const REINDEX_POLL_INTERVAL = 3000; // ms between refetches while indexing
  const REINDEX_POLL_CAP_MS = 120000; // ~2 min hard cap
  const [reindexDeadline, setReindexDeadline] = useState<number | null>(null);

  // Only admins may read the (masked) AI settings; the server enforces this too.
  const { data: settings, isLoading } = useAiSettingsQuery(isAdmin, (query) => {
    if (reindexDeadline === null) return false;
    // Past the cap → stop polling (cleared via the effect below too).
    if (Date.now() > reindexDeadline) return false;
    const data = query.state.data;
    // Stop once everything is indexed; otherwise keep polling.
    if (data && data.indexedPages >= data.totalPages) return false;
    return REINDEX_POLL_INTERVAL;
  });

  // Stop polling once the work is done or the cap is reached. Also clears on
  // unmount because the deadline state goes away with the component.
  useEffect(() => {
    if (reindexDeadline === null) return;
    // "Done" matches the refetchInterval stop condition (indexed >= total),
    // including an empty workspace (0 >= 0), so the deadline clears promptly
    // instead of waiting out the cap.
    if (settings && settings.indexedPages >= settings.totalPages) {
      setReindexDeadline(null);
      return;
    }
    const msLeft = reindexDeadline - Date.now();
    if (msLeft <= 0) {
      setReindexDeadline(null);
      return;
    }
    const timer = setTimeout(() => setReindexDeadline(null), msLeft);
    return () => clearTimeout(timer);
  }, [reindexDeadline, settings]);

  const updateMutation = useUpdateAiSettingsMutation();
  const reindexMutation = useReindexAiEmbeddingsMutation();

  // Independent test mutations so each card has its own loading + result.
  const chatTest = useTestAiConnectionMutation();
  const embedTest = useTestAiConnectionMutation();
  const sttTest = useTestAiConnectionMutation();

  // Which card's "Save and test" is currently mid-save. The save mutation is
  // shared, so without this every save-and-test button would spin at once;
  // this lets only the clicked card's button show the spinner during the save.
  const [savingTestCapability, setSavingTestCapability] =
    useState<AiTestCapability | null>(null);

  // Agent roles drive the public-share assistant identity picker. Admin-gated
  // (the component returns early for non-admins), same as the AI settings query.
  const { data: roles } = useAiRolesQuery(isAdmin);

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
  const [streamingDictationEnabled, setStreamingDictationEnabled] =
    useState<boolean>(workspace?.settings?.ai?.dictationStreaming ?? false);
  const [publicShareAssistantEnabled, setPublicShareAssistantEnabled] =
    useState<boolean>(
      workspace?.settings?.ai?.publicShareAssistant ?? false,
    );
  const [chatToggleLoading, setChatToggleLoading] = useState(false);
  const [searchToggleLoading, setSearchToggleLoading] = useState(false);
  const [dictationToggleLoading, setDictationToggleLoading] = useState(false);
  const [streamingDictationToggleLoading, setStreamingDictationToggleLoading] =
    useState(false);
  const [
    publicShareAssistantToggleLoading,
    setPublicShareAssistantToggleLoading,
  ] = useState(false);

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
      chatApiStyle: "openai-compatible" as ChatApiStyle,
      publicShareChatModel: "",
      publicShareAssistantRoleId: "",
      embeddingModel: "",
      baseUrl: "",
      embeddingBaseUrl: "",
      systemPrompt: "",
      apiKey: "",
      embeddingApiKey: "",
      sttModel: "",
      sttBaseUrl: "",
      sttApiStyle: "multipart" as SttApiStyle,
      sttLanguage: "",
      sttApiKey: "",
    },
  });

  // Hydrate the form once the masked settings load. We ignore `settings.driver`
  // entirely — the driver is always "openai".
  useEffect(() => {
    if (!settings) return;
    form.setValues({
      chatModel: settings.chatModel ?? "",
      chatApiStyle: settings.chatApiStyle ?? "openai-compatible",
      publicShareChatModel: settings.publicShareChatModel ?? "",
      publicShareAssistantRoleId: settings.publicShareAssistantRoleId ?? "",
      embeddingModel: settings.embeddingModel ?? "",
      baseUrl: settings.baseUrl ?? "",
      embeddingBaseUrl: settings.embeddingBaseUrl ?? "",
      systemPrompt: settings.systemPrompt ?? "",
      apiKey: "",
      embeddingApiKey: "",
      sttModel: settings.sttModel ?? "",
      sttBaseUrl: settings.sttBaseUrl ?? "",
      sttApiStyle: settings.sttApiStyle ?? "multipart",
      sttLanguage: settings.sttLanguage ?? "",
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
      chatApiStyle: values.chatApiStyle,
      // Cheap model id for the anonymous public-share assistant; empty falls
      // back to chatModel server-side.
      publicShareChatModel: values.publicShareChatModel,
      // Agent-role id whose persona the public-share assistant adopts; empty =
      // built-in locked persona server-side.
      publicShareAssistantRoleId: values.publicShareAssistantRoleId,
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
      sttLanguage: values.sttLanguage,
    };

    // Key semantics (never send the stored key back) — see resolveKeyField:
    //   - typed a value -> set it
    //   - explicitly cleared -> send '' to clear
    //   - untouched -> omit the key entirely (leave unchanged)
    const apiKeyField = resolveKeyField(values.apiKey, keyCleared);
    if (apiKeyField.set) payload.apiKey = apiKeyField.value;

    // Same write-only semantics for the embedding-specific key.
    const embeddingKeyField = resolveKeyField(
      values.embeddingApiKey,
      embeddingKeyCleared,
    );
    if (embeddingKeyField.set) payload.embeddingApiKey = embeddingKeyField.value;

    // Same write-only semantics for the STT-specific key.
    const sttKeyField = resolveKeyField(values.sttApiKey, sttKeyCleared);
    if (sttKeyField.set) payload.sttApiKey = sttKeyField.value;

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

  // "Save and test" for a single card: the connection test probes the
  // SERVER-STORED settings, so the whole form must be persisted before testing.
  // Save first (handleSubmit rethrows on failure and the mutation already shows
  // its own error notification); only run the probe on a successful save.
  async function handleSaveAndTest(
    capability: AiTestCapability,
    test: ReturnType<typeof useTestAiConnectionMutation>,
  ) {
    setSavingTestCapability(capability);
    // Clear any previous probe result so the stale "successful/failed" text does
    // not linger next to the spinner while the (now preceding) save runs.
    test.reset();
    try {
      await handleSubmit(form.values);
    } catch {
      return; // save failed — error already surfaced; do not test stale settings
    } finally {
      setSavingTestCapability(null);
    }
    test.mutate(capability);
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

  // Optimistic toggle for the streaming (silence-cut) dictation sub-mode
  // (settings.ai.dictationStreaming). Only meaningful when dictation is on.
  async function handleToggleStreamingDictation(value: boolean) {
    setStreamingDictationToggleLoading(true);
    const previous = streamingDictationEnabled;
    setStreamingDictationEnabled(value);
    try {
      const updated = await updateWorkspace({ aiDictationStreaming: value });
      setWorkspace({
        ...updated,
        settings: {
          ...updated.settings,
          ai: { ...updated.settings?.ai, dictationStreaming: value },
        },
      });
      notifications.show({ message: t("Updated successfully") });
    } catch (err) {
      setStreamingDictationEnabled(previous);
      const message = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message;
      notifications.show({
        message: message ?? t("Failed to update data"),
        color: "red",
      });
    } finally {
      setStreamingDictationToggleLoading(false);
    }
  }

  // Optimistic toggle for the anonymous public-share AI assistant
  // (settings.ai.publicShareAssistant). When off, the public endpoint 404s.
  async function handleTogglePublicShareAssistant(value: boolean) {
    setPublicShareAssistantToggleLoading(true);
    const previous = publicShareAssistantEnabled;
    setPublicShareAssistantEnabled(value);
    try {
      const updated = await updateWorkspace({
        aiPublicShareAssistant: value,
      });
      setWorkspace({
        ...updated,
        settings: {
          ...updated.settings,
          ai: { ...updated.settings?.ai, publicShareAssistant: value },
        },
      });
      notifications.show({ message: t("Updated successfully") });
    } catch (err) {
      setPublicShareAssistantEnabled(previous);
      const message = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message;
      notifications.show({
        message: message ?? t("Failed to update data"),
        color: "red",
      });
    } finally {
      setPublicShareAssistantToggleLoading(false);
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
  const embedConfigured = isEndpointConfigured(
    v.embeddingModel,
    v.embeddingBaseUrl,
    v.baseUrl,
  );
  const sttConfigured = isEndpointConfigured(v.sttModel, v.sttBaseUrl, v.baseUrl);

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

  // Public-share assistant identity options: a leading "built-in persona" entry
  // (empty value, the server default) plus every enabled agent role. If the saved
  // role was since disabled it is filtered out of the enabled list, so surface it
  // explicitly (labeled "disabled") instead of letting the Select render a blank
  // field for a still-stored id.
  const selectedRoleId = form.values.publicShareAssistantRoleId;
  const enabledRoles = (roles ?? []).filter((r: IAiRole) => r.enabled);
  const selectedDisabledRole =
    selectedRoleId.length > 0 &&
    !enabledRoles.some((r: IAiRole) => r.id === selectedRoleId)
      ? (roles ?? []).find((r: IAiRole) => r.id === selectedRoleId)
      : undefined;
  const roleOptions = [
    { value: "", label: t("Built-in assistant persona") },
    ...enabledRoles.map((r: IAiRole) => ({
      value: r.id,
      label: r.emoji ? `${r.emoji} ${r.name}` : r.name,
    })),
    ...(selectedDisabledRole
      ? [
          {
            value: selectedDisabledRole.id,
            label: `${selectedDisabledRole.emoji ? `${selectedDisabledRole.emoji} ` : ""}${selectedDisabledRole.name} (${t("disabled")})`,
          },
        ]
      : []),
  ];

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
          {/* The key field is write-only: the stored key never loads back, so the
              built-in visibility toggle reveals nothing. Replace it with a Clear
              action in the right section. Passing rightSection suppresses the eye
              (Mantine). While typing a new key (buffer non-empty) fall back to
              the default eye so the user can verify what they typed. */}
          <PasswordInput
            label={t("API key")}
            placeholder={hasApiKey ? t("•••• set") : ""}
            autoComplete="off"
            rightSection={
              hasApiKey && form.values.apiKey.length === 0 ? (
                <Tooltip label={t("Clear")} position="top" withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    aria-label={t("Clear")}
                    type="button"
                    onClick={handleClearKey}
                  >
                    <IconX size={16} />
                  </ActionIcon>
                </Tooltip>
              ) : undefined
            }
            rightSectionPointerEvents="all"
            {...form.getInputProps("apiKey")}
          />
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

        <Select
          mt="sm"
          label={t("Protocol")}
          description={t(
            "How chat requests are sent and how reasoning is surfaced",
          )}
          data={[
            {
              value: "openai-compatible",
              label: t("OpenAI-compatible (surfaces reasoning)"),
            },
            { value: "openai", label: t("OpenAI (official)") },
          ]}
          allowDeselect={false}
          disabled={isLoading}
          {...form.getInputProps("chatApiStyle")}
        />

        {/* Anonymous public-share assistant: a single master toggle + an
            optional cheaper model id. Reuses this card's driver/URL/key. */}
        <Group justify="space-between" align="center" wrap="nowrap" mt="md">
          <Text fw={600} size="sm">
            {t("Public share assistant")}
          </Text>
          <Switch
            label={t("Enabled")}
            labelPosition="left"
            checked={publicShareAssistantEnabled}
            disabled={publicShareAssistantToggleLoading}
            onChange={(e) =>
              handleTogglePublicShareAssistant(e.currentTarget.checked)
            }
          />
        </Group>
        <Text size="xs" c="dimmed" mt={4} mb="xs">
          {t(
            "Let anonymous visitors of public shares ask an AI assistant scoped to that share's pages. You pay for the tokens.",
          )}
        </Text>
        <TextInput
          label={t("Public assistant model")}
          placeholder={t("Defaults to the chat model")}
          disabled={isLoading || !publicShareAssistantEnabled}
          {...form.getInputProps("publicShareChatModel")}
        />
        <Text size="xs" c="dimmed" mt={4}>
          {t(
            "Optional cheaper model id for the public assistant. Empty uses the chat model above.",
          )}
        </Text>
        <Select
          mt="sm"
          label={t("Assistant identity")}
          description={t(
            "Pick an agent role whose persona the public assistant adopts. The safety rules always still apply.",
          )}
          data={roleOptions}
          allowDeselect={false}
          disabled={isLoading || !publicShareAssistantEnabled}
          {...form.getInputProps("publicShareAssistantRoleId")}
        />

        <Group mt="md" align="center">
          <Button
            variant="default"
            size="sm"
            loading={savingTestCapability === "chat" || chatTest.isPending}
            disabled={
              updateMutation.isPending || chatTest.isPending || !form.isValid()
            }
            onClick={() => void handleSaveAndTest("chat", chatTest)}
          >
            {t("Save and test")}
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
          {/* The key field is write-only: the stored key never loads back, so the
              built-in visibility toggle reveals nothing. Replace it with a Clear
              action in the right section. Passing rightSection suppresses the eye
              (Mantine). While typing a new key (buffer non-empty) fall back to
              the default eye so the user can verify what they typed. */}
          <PasswordInput
            label={t("Embedding API key")}
            placeholder={
              hasEmbeddingApiKey
                ? t("•••• set")
                : t("Leave empty to use the chat API key")
            }
            autoComplete="off"
            rightSection={
              hasEmbeddingApiKey && form.values.embeddingApiKey.length === 0 ? (
                <Tooltip label={t("Clear")} position="top" withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    aria-label={t("Clear")}
                    type="button"
                    onClick={handleClearEmbeddingKey}
                  >
                    <IconX size={16} />
                  </ActionIcon>
                </Tooltip>
              ) : undefined
            }
            rightSectionPointerEvents="all"
            {...form.getInputProps("embeddingApiKey")}
          />
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
            loading={savingTestCapability === "embeddings" || embedTest.isPending}
            disabled={
              updateMutation.isPending || embedTest.isPending || !form.isValid()
            }
            onClick={() => void handleSaveAndTest("embeddings", embedTest)}
          >
            {t("Save and test")}
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
              onClick={() =>
                reindexMutation.mutate(undefined, {
                  // Begin bounded polling so the counter climbs as the async
                  // background job indexes (it does not update on its own).
                  onSuccess: () =>
                    setReindexDeadline(Date.now() + REINDEX_POLL_CAP_MS),
                })
              }
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

        {/* Streaming dictation is a sub-mode of voice dictation: it cuts on
            pauses and transcribes each segment as you speak. Disabled unless
            dictation itself is on. */}
        <Group justify="space-between" align="center" wrap="nowrap">
          <Stack gap={0}>
            <Text fw={600} size="sm">
              {t("Streaming dictation")}
            </Text>
            <Text size="xs" c="dimmed">
              {t("Transcribe as you speak, cutting on pauses")}
            </Text>
          </Stack>
          <Switch
            label={t("Streaming dictation")}
            labelPosition="left"
            checked={streamingDictationEnabled}
            disabled={
              !dictationEnabled ||
              dictationToggleLoading ||
              streamingDictationToggleLoading
            }
            onChange={(e) =>
              handleToggleStreamingDictation(e.currentTarget.checked)
            }
          />
        </Group>

        <Group grow align="flex-start">
          <TextInput
            label={t("Model")}
            disabled={isLoading}
            {...form.getInputProps("sttModel")}
          />
          {/* The key field is write-only: the stored key never loads back, so the
              built-in visibility toggle reveals nothing. Replace it with a Clear
              action in the right section. Passing rightSection suppresses the eye
              (Mantine). While typing a new key (buffer non-empty) fall back to
              the default eye so the user can verify what they typed. */}
          <PasswordInput
            label={t("API key")}
            placeholder={
              hasSttApiKey
                ? t("•••• set")
                : t("Leave empty to use the chat API key")
            }
            autoComplete="off"
            rightSection={
              hasSttApiKey && form.values.sttApiKey.length === 0 ? (
                <Tooltip label={t("Clear")} position="top" withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    aria-label={t("Clear")}
                    type="button"
                    onClick={handleClearSttKey}
                  >
                    <IconX size={16} />
                  </ActionIcon>
                </Tooltip>
              ) : undefined
            }
            rightSectionPointerEvents="all"
            {...form.getInputProps("sttApiKey")}
          />
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

        <Select
          mt="sm"
          label={t("Dictation language")}
          description={t(
            "Spoken language hint sent to the transcription model. Auto-detect lets the model decide.",
          )}
          data={[
            { value: "", label: t("Auto-detect") },
            ...STT_LANGUAGE_OPTIONS,
          ]}
          searchable
          allowDeselect={false}
          disabled={isLoading}
          {...form.getInputProps("sttLanguage")}
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
            loading={savingTestCapability === "stt" || sttTest.isPending}
            disabled={
              updateMutation.isPending || sttTest.isPending || !form.isValid()
            }
            onClick={() => void handleSaveAndTest("stt", sttTest)}
          >
            {t("Save and test")}
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
