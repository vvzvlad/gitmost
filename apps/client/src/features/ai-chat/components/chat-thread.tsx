import { useMemo, useRef } from "react";
import { Alert, Box, Stack } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import MessageList from "@/features/ai-chat/components/message-list.tsx";
import ChatInput from "@/features/ai-chat/components/chat-input.tsx";
import { IAiChatMessageRow } from "@/features/ai-chat/types/ai-chat.types.ts";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

interface ChatThreadProps {
  /** The open chat id, or null for a brand-new (not-yet-created) chat. */
  chatId: string | null;
  /** Persisted rows to seed initial messages (existing chats only). */
  initialRows?: IAiChatMessageRow[];
  /** Called when a turn finishes; the parent refreshes the chat list and, for
   *  a new chat, adopts the freshly created chat id. */
  onTurnFinished: () => void;
}

/**
 * Map a persisted server row to an AI SDK UIMessage. Mirrors the server's
 * `rowToUiMessage`: `metadata.parts` are the UIMessage parts; otherwise fall
 * back to a single text part built from the plain-text `content`.
 */
function rowToUiMessage(row: IAiChatMessageRow): UIMessage {
  const role = row.role === "assistant" ? "assistant" : "user";
  const parts =
    Array.isArray(row.metadata?.parts) && row.metadata.parts.length > 0
      ? row.metadata.parts
      : ([{ type: "text", text: row.content ?? "" }] as UIMessage["parts"]);
  return { id: row.id, role, parts } as UIMessage;
}

/**
 * Owns the AI SDK `useChat` lifecycle for ONE chat. The parent remounts this
 * with a `key` when the selected chat changes, so initial messages re-seed
 * cleanly (the v6 transport-based hook keeps its state per mount).
 */
export default function ChatThread({
  chatId,
  initialRows,
  onTurnFinished,
}: ChatThreadProps) {
  const { t } = useTranslation();

  const initialMessages = useMemo<UIMessage[]>(
    () => (initialRows ?? []).map(rowToUiMessage),
    [initialRows],
  );

  // The server resolves/creates the chat from the `chatId` in the request body.
  // A new chat starts as null; we keep the id in a ref so the SAME hook instance
  // can keep streaming to a chat once it exists (the parent adopts the id on
  // finish, but within this mount the body carries whatever we know).
  const chatIdRef = useRef<string | null>(chatId);
  chatIdRef.current = chatId;

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/ai-chat/stream",
        credentials: "include",
        // Inject the chat id alongside the useChat messages so the server can
        // resolve an existing chat (or create one when null).
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: { ...body, chatId: chatIdRef.current, messages },
        }),
      }),
    [],
  );

  const { messages, sendMessage, status, stop, error } = useChat({
    // Key the hook by the chat id so shared-id chats don't collide.
    id: chatId ?? undefined,
    messages: initialMessages,
    transport,
    onFinish: () => onTurnFinished(),
  });

  const isStreaming = status === "submitted" || status === "streaming";

  return (
    <Box className={classes.panel}>
      <MessageList messages={messages} isStreaming={isStreaming} />

      {error && (
        <Alert
          variant="light"
          color="red"
          icon={<IconAlertTriangle size={16} />}
          mb="xs"
          title={t("Something went wrong")}
        >
          {describeError(error, t)}
        </Alert>
      )}

      <Stack gap={0} className={classes.inputWrapper}>
        <ChatInput
          onSend={(text) => sendMessage({ text })}
          onStop={stop}
          isStreaming={isStreaming}
        />
      </Stack>
    </Box>
  );
}

/**
 * Turn a useChat error into a friendly inline message. The transport throws on
 * non-2xx with the response text/status in the message, so we pattern-match the
 * gating responses (403 chat disabled, 503 provider not configured) and fall
 * back to a generic message otherwise — never a crash.
 */
function describeError(
  error: Error,
  t: (key: string) => string,
): string {
  const msg = error.message ?? "";
  if (msg.includes("403") || /disabled/i.test(msg)) {
    return t("AI chat is disabled for this workspace.");
  }
  if (msg.includes("503") || /not configured/i.test(msg)) {
    return t("The AI provider is not configured. Ask an administrator to set it up.");
  }
  return t("The AI agent could not respond. Please try again.");
}
