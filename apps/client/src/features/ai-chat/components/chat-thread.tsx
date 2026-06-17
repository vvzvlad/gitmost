import { useMemo, useRef } from "react";
import { generateId } from "ai";
import { Alert, Box, Stack } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import MessageList from "@/features/ai-chat/components/message-list.tsx";
import ChatInput from "@/features/ai-chat/components/chat-input.tsx";
import { IAiChatMessageRow } from "@/features/ai-chat/types/ai-chat.types.ts";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

/** The page the user is currently viewing, sent as chat context. */
export interface OpenPageContext {
  id: string;
  title: string;
}

interface ChatThreadProps {
  /** The open chat id, or null for a brand-new (not-yet-created) chat. */
  chatId: string | null;
  /** Persisted rows to seed initial messages (existing chats only). */
  initialRows?: IAiChatMessageRow[];
  /** The page currently open in the workspace, or null on a non-page route.
   *  Sent with each turn so the agent knows what "this page" refers to. */
  openPage?: OpenPageContext | null;
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
  openPage,
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

  // Keep the currently-open page in a ref, updated each render, so the LATEST
  // open page is sent on every send WITHOUT re-creating the `useMemo([])`-stable
  // transport (and thus without re-creating the useChat store mid-stream — see
  // the `chatStoreId` note below). Read live inside `prepareSendMessagesRequest`.
  const openPageRef = useRef<OpenPageContext | null>(openPage ?? null);
  openPageRef.current = openPage ?? null;

  // Stable `useChat` store key for the lifetime of THIS mount.
  //
  // CRITICAL: `useChat` (@ai-sdk/react) re-creates its internal `Chat` store
  // whenever the `id` option no longer equals the store's current id
  // (`"id" in options && chatRef.current.id !== options.id`). For a brand-new
  // chat (`chatId === null`) we previously passed `id: undefined`; the store
  // then generated its OWN random id internally, so `store.id !== undefined`
  // stayed true on EVERY render and the store was re-created on every render —
  // wiping the optimistic user message, the "submitted" status, and every
  // streamed delta until the turn fully finished (then the parent adopts the
  // new chat id and remounts with the persisted history, making everything
  // "appear at once"). Passing a STABLE non-undefined id keeps one store for
  // the whole turn, so the user message shows immediately and tokens stream
  // live. This id is purely the client store key; the server still resolves the
  // real chat from `chatId` in the request body (see `prepareSendMessagesRequest`).
  // The id only needs to be stable per mount — the parent remounts this via
  // `key` on chat switch, which re-seeds cleanly.
  const stableIdRef = useRef<string>(chatId ?? `new-${generateId()}`);
  const chatStoreId = chatId ?? stableIdRef.current;

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/ai-chat/stream",
        credentials: "include",
        // Inject the chat id and the currently-open page alongside the useChat
        // messages so the server can resolve an existing chat (or create one
        // when null) and tell the agent which page "this page" refers to. Both
        // are read live from refs so changing chats/pages does NOT recreate the
        // transport. `openPage` is null on a non-page route.
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: {
            ...body,
            chatId: chatIdRef.current,
            openPage: openPageRef.current,
            messages,
          },
        }),
      }),
    [],
  );

  const { messages, sendMessage, status, stop, error } = useChat({
    // Stable per-mount key. Existing chats use their real id; new chats use a
    // generated client id (never `undefined`) so the store is NOT re-created on
    // every render mid-stream (see `chatStoreId` above).
    id: chatStoreId,
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
