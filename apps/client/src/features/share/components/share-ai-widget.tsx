import { useMemo, useRef, useState } from "react";
import { generateId } from "ai";
import {
  ActionIcon,
  Affix,
  Alert,
  Box,
  Group,
  Paper,
  Text,
  Textarea,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowUp,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import MessageList from "@/features/ai-chat/components/message-list.tsx";

interface ShareAiWidgetProps {
  /** The share id (or key) the assistant is scoped to. */
  shareId: string;
  /** The page the reader currently has open (context for "this page"). */
  pageId: string;
}

/**
 * Lightweight, EPHEMERAL "Ask AI" widget for a public shared page.
 *
 * A stripped version of the authenticated chat: text input only, no chat list,
 * no history, no persistence, no voice input. The transcript lives only in
 * memory (this component's `useChat` store) and is sent with `credentials:
 * "omit"` to the anonymous `/api/shares/ai/stream` endpoint. The server stores
 * nothing.
 *
 * Presentation is now shared with the internal chat: the same `MessageList`
 * renders the streamed transcript, so the public share gets the SAME
 * incremental markdown render, animated typing indicator, and tool-call cards
 * as the internal chat. Only the anonymous specifics differ — no auth, no
 * history, `credentials: "omit"`, suppressed page citations (an anonymous
 * reader cannot open the linked internal pages), neutralized internal markdown
 * links (so internal UUIDs/auth-gated routes in the answer don't leak as
 * clickable links), and a documentation-focused empty state.
 */
export default function ShareAiWidget({ shareId, pageId }: ShareAiWidgetProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");

  // Stable per-mount store key (see ai-chat ChatThread for the rationale on why
  // useChat needs a stable, non-undefined id to avoid re-creating its store).
  const storeIdRef = useRef<string>(`share-ai-${generateId()}`);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/shares/ai/stream",
        // Anonymous endpoint: never send cookies/credentials.
        credentials: "omit",
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: {
            ...body,
            shareId,
            pageId,
            messages,
          },
        }),
      }),
    [shareId, pageId],
  );

  const { messages, sendMessage, status, stop, error } = useChat({
    id: storeIdRef.current,
    transport,
  });

  const isStreaming = status === "submitted" || status === "streaming";

  const handleSend = () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    void sendMessage({ text });
  };

  if (!open) {
    return (
      // Offset 80px from the bottom so the FAB stacks ABOVE the bottom-right
      // "Powered by Gitmost" branding button (share-branding.tsx) without
      // overlapping it.
      <Affix position={{ bottom: 80, right: 20 }}>
        <Tooltip label={t("Ask AI")} position="left">
          <ActionIcon
            size="xl"
            radius="xl"
            variant="filled"
            aria-label={t("Ask AI")}
            onClick={() => setOpen(true)}
          >
            <IconSparkles size={22} />
          </ActionIcon>
        </Tooltip>
      </Affix>
    );
  }

  return (
    <Affix position={{ bottom: 80, right: 20 }}>
      <Paper
        shadow="md"
        radius="md"
        withBorder
        style={{
          width: 360,
          maxWidth: "calc(100vw - 40px)",
          height: 480,
          maxHeight: "calc(100vh - 100px)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Group
          justify="space-between"
          p="xs"
          style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
        >
          <Group gap="xs">
            <IconSparkles size={18} />
            <Text fw={600} size="sm">
              {t("Ask AI")}
            </Text>
          </Group>
          <ActionIcon
            variant="subtle"
            aria-label={t("Close")}
            onClick={() => setOpen(false)}
          >
            <IconX size={18} />
          </ActionIcon>
        </Group>

        {/* Shared transcript: same incremental streaming render, animated typing
            indicator, markdown, and tool-call cards as the internal chat. The
            share is anonymous, so page citation links are suppressed (an
            anonymous reader cannot open the linked internal pages). */}
        <Box style={{ flex: 1, minHeight: 0, display: "flex", padding: "var(--mantine-spacing-sm)" }}>
          <MessageList
            messages={messages}
            isStreaming={isStreaming}
            showCitations={false}
            // Anonymous reader: neutralize internal/relative links in the
            // assistant's markdown so internal UUIDs/auth-gated routes don't
            // leak as clickable links (external http(s) links are kept).
            neutralizeInternalLinks={true}
            emptyState={
              <Text size="sm" c="dimmed" ta="center">
                {t("Ask a question about this documentation.")}
              </Text>
            }
          />
        </Box>

        {error && (
          <Alert
            variant="light"
            color="red"
            icon={<IconAlertTriangle size={16} />}
            mx="sm"
            mb="xs"
            title={t("Something went wrong")}
          >
            {t("The assistant is unavailable right now. Please try again.")}
          </Alert>
        )}

        <Group
          gap="xs"
          p="xs"
          align="flex-end"
          style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
        >
          <Textarea
            style={{ flex: 1 }}
            autosize
            minRows={1}
            maxRows={4}
            placeholder={t("Ask a question…")}
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          <ActionIcon
            size="lg"
            radius="xl"
            variant="filled"
            aria-label={isStreaming ? t("Stop") : t("Send")}
            onClick={isStreaming ? () => stop() : handleSend}
            disabled={!isStreaming && input.trim().length === 0}
          >
            {isStreaming ? <IconX size={18} /> : <IconArrowUp size={18} />}
          </ActionIcon>
        </Group>
      </Paper>
    </Affix>
  );
}
