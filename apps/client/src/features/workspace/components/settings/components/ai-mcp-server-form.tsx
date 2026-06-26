import { useEffect, useState } from "react";
import { z } from "zod/v4";
import {
  Alert,
  Button,
  Group,
  List,
  PasswordInput,
  Select,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { IconCheck, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  useCreateAiMcpServerMutation,
  useUpdateAiMcpServerMutation,
  useTestAiMcpServerMutation,
} from "@/features/workspace/queries/ai-mcp-server-query.ts";
import {
  IAiMcpServer,
  IAiMcpServerCreate,
  IAiMcpServerUpdate,
} from "@/features/workspace/services/ai-mcp-server-service.ts";

const formSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(["http", "sse"]),
  url: z.string().min(1),
  // Write-only secret buffer. Empty string means "do not change" (unless cleared).
  authHeader: z.string(),
  toolAllowlist: z.array(z.string()),
  // Admin-authored prompt guidance (#180). Capped to mirror the DTO MaxLength.
  instructions: z.string().max(4000),
  enabled: z.boolean(),
});

type FormValues = z.infer<typeof formSchema>;

interface AiMcpServerFormProps {
  // When provided, the form edits an existing server; otherwise it creates one.
  server?: IAiMcpServer;
  onClose: () => void;
}

// Build the form's field values from a (possibly undefined) server. Used both
// for the initial mount and for re-hydration when the modal is reused for a
// different server, so the two stay in sync. authHeader is always empty: it is
// a write-only secret buffer never echoed back from the server.
function buildInitialValues(server?: IAiMcpServer): FormValues {
  return {
    name: server?.name ?? "",
    transport: server?.transport ?? "http",
    url: server?.url ?? "",
    authHeader: "",
    // Defensive: TagsInput calls `.map`, so a non-array here (e.g. an API that
    // returns the jsonb column as a JSON string) would crash the whole page. The
    // server normalizes this now, but guard anyway so a bad shape can never take
    // the settings UI down.
    toolAllowlist: Array.isArray(server?.toolAllowlist)
      ? server.toolAllowlist
      : [],
    instructions: server?.instructions ?? "",
    enabled: server?.enabled ?? true,
  };
}

export default function AiMcpServerForm({
  server,
  onClose,
}: AiMcpServerFormProps) {
  const { t } = useTranslation();
  const isEdit = Boolean(server);

  const createMutation = useCreateAiMcpServerMutation();
  const updateMutation = useUpdateAiMcpServerMutation();
  const testMutation = useTestAiMcpServerMutation();

  // Whether auth headers are currently stored server-side (drives the placeholder).
  const [hasHeaders, setHasHeaders] = useState(server?.hasHeaders ?? false);
  // Tracks whether the user explicitly cleared the stored auth headers.
  const [headersCleared, setHeadersCleared] = useState(false);

  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    initialValues: buildInitialValues(server),
  });

  // Re-hydrate when the target server changes (e.g. reusing the modal).
  useEffect(() => {
    form.setValues(buildInitialValues(server));
    form.resetDirty();
    setHasHeaders(server?.hasHeaders ?? false);
    setHeadersCleared(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id]);

  const transportOptions = [
    { value: "http", label: "HTTP" },
    { value: "sse", label: "SSE" },
  ];

  // Map the single Authorization value to a headers map, honouring write-only
  // semantics: typed value -> set; explicitly cleared -> {} (clear); else omit.
  function resolveHeaders(): Record<string, string> | undefined {
    if (form.values.authHeader.length > 0) {
      return { Authorization: form.values.authHeader };
    }
    if (headersCleared) {
      return {};
    }
    return undefined;
  }

  async function handleSubmit(values: FormValues) {
    const headers = resolveHeaders();

    if (isEdit && server) {
      const payload: IAiMcpServerUpdate = {
        id: server.id,
        name: values.name,
        transport: values.transport,
        url: values.url,
        toolAllowlist: values.toolAllowlist,
        // Always sent: a blank value clears the stored guidance (server -> null).
        instructions: values.instructions,
        enabled: values.enabled,
      };
      // Only attach headers when set or explicitly cleared (omit => unchanged).
      if (headers !== undefined) payload.headers = headers;
      await updateMutation.mutateAsync(payload);
    } else {
      const payload: IAiMcpServerCreate = {
        name: values.name,
        transport: values.transport,
        url: values.url,
        toolAllowlist: values.toolAllowlist,
        // Blank => server stores null (no guidance).
        instructions: values.instructions,
        enabled: values.enabled,
      };
      // On create, only a typed value matters (no prior stored headers).
      if (headers !== undefined && Object.keys(headers).length > 0) {
        payload.headers = headers;
      }
      await createMutation.mutateAsync(payload);
    }

    onClose();
  }

  function handleClearHeaders() {
    setHeadersCleared(true);
    setHasHeaders(false);
    form.setFieldValue("authHeader", "");
  }

  const testResult = testMutation.data;
  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <Stack>
      <TextInput label={t("Server name")} {...form.getInputProps("name")} />

      <Select
        label={t("Transport")}
        data={transportOptions}
        allowDeselect={false}
        {...form.getInputProps("transport")}
      />

      <TextInput label={t("URL")} {...form.getInputProps("url")} />

      <PasswordInput
        label={t("Authorization header")}
        // Clarify that the value is sent verbatim as the Authorization header,
        // so the user supplies the full scheme (no implicit Bearer prefix).
        description={t(
          'Sent verbatim as the value of the Authorization header (e.g. "Bearer <token>" or "Basic <base64>").',
        )}
        // Placeholder hints whether headers are stored; the value is never shown.
        placeholder={hasHeaders ? t("•••• set") : ""}
        autoComplete="off"
        {...form.getInputProps("authHeader")}
      />

      {hasHeaders && (
        <Group justify="flex-start" mt={-8}>
          <Button
            variant="subtle"
            size="compact-sm"
            color="red"
            onClick={handleClearHeaders}
          >
            {t("Clear")}
          </Button>
        </Group>
      )}

      <TagsInput
        label={t("Tool allowlist")}
        description={t(
          "Optional. Leave empty to allow all tools the server exposes.",
        )}
        splitChars={[",", " "]}
        clearable
        {...form.getInputProps("toolAllowlist")}
      />

      <Textarea
        label={t("Instructions")}
        // Hint that the text is injected into the agent's system prompt and that
        // the server's tools are namespaced under <name>_* (the prompt header).
        description={t(
          "Optional guidance for the agent on how and when to use this server's tools. Injected into the system prompt. The server's tools are namespaced as \"<server name>_*\".",
        )}
        autosize
        minRows={2}
        maxRows={8}
        maxLength={4000}
        {...form.getInputProps("instructions")}
      />

      <Switch
        label={t("Enabled")}
        checked={form.values.enabled}
        onChange={(event) =>
          form.setFieldValue("enabled", event.currentTarget.checked)
        }
      />

      {testResult && (
        <Alert
          color={testResult.ok ? "green" : "red"}
          icon={testResult.ok ? <IconCheck size={16} /> : <IconX size={16} />}
        >
          {testResult.ok ? (
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                {t("Available tools")}
              </Text>
              {testResult.tools.length > 0 ? (
                <List size="sm">
                  {testResult.tools.map((tool) => (
                    <List.Item key={tool}>{tool}</List.Item>
                  ))}
                </List>
              ) : (
                <Text size="sm">{t("No tools available")}</Text>
              )}
            </Stack>
          ) : (
            // `in` narrows the discriminated union to the error member.
            ("error" in testResult && testResult.error) ||
            t("Connection failed")
          )}
        </Alert>
      )}

      <Group justify="space-between" mt="sm">
        {/* Test runs against the SAVED server, so it's only available in edit mode. */}
        {isEdit && server ? (
          <Button
            type="button"
            variant="default"
            onClick={() => testMutation.mutate(server.id)}
            loading={testMutation.isPending}
          >
            {t("Test")}
          </Button>
        ) : (
          <span />
        )}

        <Group>
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
      </Group>
    </Stack>
  );
}
