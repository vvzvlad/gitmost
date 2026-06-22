import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { generateId } from "ai";
import { ActionIcon, Box, Group, Stack, Text } from "@mantine/core";
import { IconClockHour4, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import MessageList from "@/features/ai-chat/components/message-list.tsx";
import ChatInput from "@/features/ai-chat/components/chat-input.tsx";
import RoleCards from "@/features/ai-chat/components/role-cards.tsx";
import ChatErrorAlert from "@/features/ai-chat/components/chat-error-alert.tsx";
import {
  IAiChatMessageRow,
  IAiRole,
} from "@/features/ai-chat/types/ai-chat.types.ts";
import { describeChatError } from "@/features/ai-chat/utils/error-message.ts";
import {
  dequeue,
  enqueueMessage,
  removeQueuedById,
  type QueuedMessage,
} from "@/features/ai-chat/utils/queue-helpers.ts";
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
  /** The agent role selected for a NEW chat (null = universal assistant). Sent
   *  in the request body so the server persists it on chat creation; ignored by
   *  the server for existing chats (the role is read from the chat row). */
  roleId?: string | null;
  /** Enabled roles for the new-chat empty state (only meaningful when
   *  `chatId === null`). Rendered as the colored role cards. */
  roles?: IAiRole[];
  /** Notify the parent which role was picked via a card, so it can update the
   *  header badge / assistant name for the brand-new chat. */
  onRolePicked?: (role: IAiRole) => void;
  /** Display name for the assistant label / typing line (the role name);
   *  forwarded to MessageList. Absent => the generic "AI agent". */
  assistantName?: string;
  /** Called when a turn finishes; the parent refreshes the chat list and, for
   *  a new chat, adopts the freshly created chat id. */
  onTurnFinished: () => void;
  /** Parent-owned ref that this thread keeps updated with its live useChat
   *  snapshot (full message list + streaming flag), so the header's
   *  "Copy chat" export can include the in-progress, not-yet-persisted
   *  assistant message. A ref (not state) avoids re-rendering the parent on
   *  every streamed delta. */
  liveStateRef?: MutableRefObject<{ messages: UIMessage[]; isStreaming: boolean }>;
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
  const error = row.metadata?.error;
  return {
    id: row.id,
    role,
    parts,
    // Carry a persisted turn error so MessageItem can render it after a remount
    // (e.g. when a new chat adopts its id) and in reopened chat history.
    ...(error ? { metadata: { error } } : {}),
  } as UIMessage;
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
  roleId,
  roles,
  onRolePicked,
  assistantName,
  onTurnFinished,
  liveStateRef,
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

  // Keep the selected role id in a ref, same rationale as openPageRef. Only the
  // FIRST request of a brand-new chat uses it (the server persists it then and
  // ignores it for existing chats), but sending it on every send is harmless.
  const roleIdRef = useRef<string | null>(roleId ?? null);
  roleIdRef.current = roleId ?? null;

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
  // Stable for the LIFETIME of this mount. When a brand-new chat adopts its
  // server id, the parent now updates the `chatId` prop WITHOUT remounting this
  // thread, so the store id must NOT follow `chatId`: recreating the useChat
  // store would wipe the live (just-finished) turn. The server still resolves
  // the real chat from `chatId` in the request body (see chatIdRef /
  // prepareSendMessagesRequest), so this purely-client store key can stay fixed.
  const chatStoreId = stableIdRef.current;

  // Pending messages the user composed WHILE a turn was streaming. They are sent
  // automatically, FIFO, on successful turn completion (`onFinish`). The queue is
  // LOCAL state so it is scoped to this conversation: it is cleared when the user
  // deliberately switches chat / starts a new chat (the parent remounts this via
  // `key`), but it SURVIVES in-place new-chat id adoption (no remount), so a
  // message queued during a brand-new chat's first turn is not lost. On Stop or
  // error the queue is intentionally preserved (onFinish does not fire then) so
  // the user decides what to do with the pending messages.
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  // Mirror the queue in a ref so the `onFinish` flush always reads the latest
  // queue without a stale closure; `setQueue` updates BOTH the ref and the state.
  const queuedRef = useRef<QueuedMessage[]>([]);
  const setQueue = useCallback((next: QueuedMessage[]) => {
    queuedRef.current = next;
    setQueued(next);
  }, []);

  // Capture the latest `sendMessage` (returned by useChat below) so the flush
  // helper can call the current instance from the stable `onFinish` callback.
  const sendMessageRef = useRef<((m: { text: string }) => void) | null>(null);

  // FIFO dequeue + send the next queued message (no-op when the queue is empty).
  const flushNext = useCallback(() => {
    const { head, rest } = dequeue(queuedRef.current);
    if (!head) return;
    setQueue(rest);
    sendMessageRef.current?.({ text: head.text });
  }, [setQueue]);

  const enqueue = useCallback(
    (text: string) => {
      setQueue(enqueueMessage(queuedRef.current, { id: generateId(), text }));
    },
    [setQueue],
  );
  const removeQueued = useCallback(
    (id: string) => {
      setQueue(removeQueuedById(queuedRef.current, id));
    },
    [setQueue],
  );

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
            // Honoured by the server only when creating a new chat; null =>
            // universal assistant.
            roleId: roleIdRef.current,
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
    // `onFinish` (ai@6 useChat) fires from a `finally` on EVERY terminal outcome
    // — success, user Stop/abort (`isAbort`), network drop (`isDisconnect`), and
    // stream error (`isError`). Keep calling `onTurnFinished()` on all of them
    // (chat-list refresh + new-chat id adoption must happen even on a failed
    // first turn), but flush the pending queue ONLY on a clean finish: auto-
    // sending after the user hit Stop — or blindly retrying after a failure —
    // would be wrong, so on Stop/disconnect/error the queue is left intact for
    // the user to decide.
    onFinish: ({ isAbort, isDisconnect, isError }) => {
      onTurnFinished();
      if (isAbort || isDisconnect || isError) return;
      flushNext();
    },
    // `onError` runs in addition to `onFinish` (which ai@6 also calls on error).
    // Log the raw failure here for devtools; the UI shows a friendly classified
    // banner via `error` below. We still call `onTurnFinished()` (idempotent with
    // the onFinish call) so a brand-new chat that fails its first turn is adopted
    // and the chat list refreshes immediately rather than after a manual refresh.
    onError: (streamError) => {
      // Surface the raw failure in the browser console (devtools) for debugging;
      // the UI separately shows a friendly classified banner (see errorView).
      console.error("AI chat stream error:", streamError);
      onTurnFinished();
    },
  });

  // Keep the flush helper pointed at the latest sendMessage instance.
  sendMessageRef.current = sendMessage;

  const isStreaming = status === "submitted" || status === "streaming";

  // Mirror the live useChat snapshot into the parent-owned ref so the export
  // (handled in AiChatWindow) can include the in-progress streaming turn. The
  // cleanup clears the ref on unmount so a thread torn down by `key` on chat
  // switch can't leak its (possibly still-streaming) tail into the next chat's
  // export before the new thread's effect repopulates the ref.
  useEffect(() => {
    if (!liveStateRef) return;
    liveStateRef.current = { messages, isStreaming };
    return () => {
      liveStateRef.current = { messages: [], isStreaming: false };
    };
  }, [liveStateRef, messages, isStreaming]);

  // Classify the turn error into a heading + detail so the banner names the cause
  // (connection reset, timeout, rate limit, context overflow, quota, ...) instead
  // of a generic "Something went wrong".
  const errorView = error ? describeChatError(error.message ?? "", t) : null;

  // Clicking a role card both binds the role to THIS new chat and immediately
  // starts the conversation. roleIdRef is set synchronously here because the
  // parent's selectedRoleId state update would only reach roleIdRef on the next
  // render — after this synchronous sendMessage has already read it.
  const handleRolePick = (role: IAiRole): void => {
    roleIdRef.current = role.id;
    onRolePicked?.(role);
    sendMessage({ text: t("Take a look at the current document") });
  };
  const showRoleCards = chatId === null && (roles?.length ?? 0) > 0;
  const roleCardsEmptyState = showRoleCards ? (
    <RoleCards roles={roles ?? []} onPick={handleRolePick} />
  ) : undefined;

  return (
    <Box className={classes.panel}>
      <MessageList
        messages={messages}
        isStreaming={isStreaming}
        emptyState={roleCardsEmptyState}
        assistantName={assistantName}
      />

      {errorView && (
        <ChatErrorAlert
          title={errorView.title}
          detail={errorView.detail}
          mb="xs"
        />
      )}

      <Stack gap={0} className={classes.inputWrapper}>
        {queued.length > 0 && (
          <Stack gap={4} className={classes.queuedList}>
            {queued.map((m) => (
              <Group
                key={m.id}
                gap={6}
                wrap="nowrap"
                className={classes.queuedItem}
              >
                <IconClockHour4 size={14} className={classes.queuedIcon} />
                <Text size="xs" lineClamp={2} className={classes.queuedText}>
                  {m.text}
                </Text>
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="gray"
                  onClick={() => removeQueued(m.id)}
                  aria-label={t("Remove queued message")}
                >
                  <IconX size={12} />
                </ActionIcon>
              </Group>
            ))}
          </Stack>
        )}
        <ChatInput
          onSend={(text) => sendMessage({ text })}
          onQueue={enqueue}
          onStop={stop}
          isStreaming={isStreaming}
        />
      </Stack>
    </Box>
  );
}
