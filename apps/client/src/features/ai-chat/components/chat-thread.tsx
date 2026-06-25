import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import ChatStoppedNotice from "@/features/ai-chat/components/chat-stopped-notice.tsx";
import {
  IAiChatMessageRow,
  IAiRole,
} from "@/features/ai-chat/types/ai-chat.types.ts";
import {
  roleLaunchMessage,
  shouldResetRolePicked,
} from "@/features/ai-chat/utils/role-launch.ts";
import { describeChatError } from "@/features/ai-chat/utils/error-message.ts";
import { extractServerChatId } from "@/features/ai-chat/utils/adopt-chat-id.ts";
import { liveTurnTokens } from "@/features/ai-chat/utils/count-stream-tokens.ts";
import {
  dequeue,
  enqueueMessage,
  removeQueuedById,
  type QueuedMessage,
} from "@/features/ai-chat/utils/queue-helpers.ts";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

// Throttle how often the streamed `messages` state triggers a re-render. Without
// it, useChat updates state on EVERY token, so the whole transcript's markdown
// (marked + DOMPurify) is re-parsed per token — on a long agent run that grows
// into a quadratic CPU storm that pins the main thread and freezes the UI.
// ~50ms (20 Hz) keeps streaming visually smooth while decoupling re-render cost
// from the token rate.
const STREAM_THROTTLE_MS = 50;

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
  /** Called when a turn finishes; the parent refreshes the chat list and, for a
   *  new chat, adopts the freshly created chat id. `serverChatId` is the
   *  authoritative id the server streamed on the assistant message metadata, or
   *  undefined on a failed turn — see adopt-chat-id.ts for the full #137 design. */
  onTurnFinished: (serverChatId?: string) => void;
  /** Called EARLY (at the stream's `start` chunk) with the authoritative server
   *  chat id streamed on the assistant message metadata, so a brand-new chat
   *  adopts its real id WHILE the first turn is still streaming (#174 — makes the
   *  Copy/export button available mid-stream). Distinct from onTurnFinished,
   *  which fires only at the terminal outcome. */
  onServerChatId?: (serverChatId?: string) => void;
  /** Reports the live turn-token total (reasoning + output) for the in-flight
   *  turn so the parent can show a header badge that ticks mid-stream. THROTTLED
   *  here (~8 Hz) so the parent re-renders a handful of times a second, not on
   *  every streamed delta. Called with `null` when no turn is in flight (the
   *  parent then reverts the badge to the persisted context size). */
  onLiveTurnTokens?: (tokens: number | null) => void;
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
  const finishReason = row.metadata?.finishReason;
  const metadata: Record<string, unknown> = {};
  if (error) metadata.error = error;
  if (finishReason) metadata.finishReason = finishReason;
  return {
    id: row.id,
    role,
    parts,
    // Carry persisted turn outcome (error text and/or finishReason) so MessageItem
    // can render the error banner / "stopped" marker after a remount and in
    // reopened history.
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
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
  onServerChatId,
  onLiveTurnTokens,
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
    // See STREAM_THROTTLE_MS — bounds re-render/markdown-reparse frequency.
    experimental_throttle: STREAM_THROTTLE_MS,
    // `onFinish` (ai@6 useChat) fires from a `finally` on EVERY terminal outcome
    // — success, user Stop/abort (`isAbort`), network drop (`isDisconnect`), and
    // stream error (`isError`). Keep calling `onTurnFinished()` on all of them
    // (chat-list refresh + new-chat id adoption must happen even on a failed
    // first turn), but flush the pending queue ONLY on a clean finish: auto-
    // sending after the user hit Stop — or blindly retrying after a failure —
    // would be wrong, so on Stop/disconnect/error the queue is left intact for
    // the user to decide.
    onFinish: ({ message, isAbort, isDisconnect, isError }) => {
      // Forward the authoritative server chatId (streamed on the assistant
      // message metadata) so the parent adopts the REAL created chat id for a new
      // chat — see adopt-chat-id.ts for the full #137 design.
      onTurnFinished(extractServerChatId(message));
      // Show a neutral "stopped" marker for an aborted turn; the red error banner
      // (via `error`) already covers isError, and a clean finish clears any marker.
      if (isError) setStopNotice(null);
      else if (isAbort) setStopNotice("manual");
      else if (isDisconnect) setStopNotice("disconnect");
      else setStopNotice(null);
      if (isAbort || isDisconnect || isError) return;
      flushNext();
    },
    // `onError` runs in addition to `onFinish` (which ai@6 also calls on error).
    // Log the raw failure here for devtools; the UI shows a friendly classified
    // banner via `error` below. We still call `onTurnFinished()` with NO server id
    // (idempotent with the onFinish call): for a brand-new chat that ARMS the
    // bounded list-refetch fallback (adopt the single newly-appeared chat once the
    // refetch lands); for an existing chat it just refreshes the chat list
    // immediately rather than after a manual refresh.
    onError: (streamError) => {
      // Surface the raw failure in the browser console (devtools) for debugging;
      // the UI separately shows a friendly classified banner (see errorView).
      console.error("AI chat stream error:", streamError);
      onTurnFinished();
    },
  });

  // Keep the flush helper pointed at the latest sendMessage instance.
  sendMessageRef.current = sendMessage;

  // EARLY chat-id adoption (#174): the server streams the authoritative chat id
  // on the assistant message metadata at the `start` chunk (message.metadata.
  // chatId — see adopt-chat-id.ts / chatStreamMetadata). Forward it to the parent
  // AS SOON AS it appears (mid-stream), so a brand-new chat adopts its real id
  // WHILE the first turn is still streaming and activeChatId-gated affordances
  // (the Copy/export button) light up immediately, instead of only at onFinish.
  // Keyed by the last-seen id so we forward each distinct id exactly once. The
  // parent's onServerChatId is idempotent and a no-op once the chat has an id.
  const lastForwardedChatIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!onServerChatId) return;
    const tail = messages[messages.length - 1];
    if (tail?.role !== "assistant") return;
    const serverChatId = extractServerChatId(tail);
    if (!serverChatId || serverChatId === lastForwardedChatIdRef.current)
      return;
    lastForwardedChatIdRef.current = serverChatId;
    onServerChatId(serverChatId);
  }, [messages, onServerChatId]);

  // Live "turn was interrupted" marker for the CURRENT session. The red error
  // banner (driven by `error`) covers the error case; this covers an aborted
  // turn, distinguishing a manual Stop (`isAbort`) from a dropped connection
  // (`isDisconnect`) — a distinction only available live (the server persists
  // both as finishReason 'aborted'). Cleared when the next turn starts.
  const [stopNotice, setStopNotice] = useState<null | "manual" | "disconnect">(
    null,
  );

  const isStreaming = status === "submitted" || status === "streaming";

  // Clear the stopped marker as soon as a new turn begins streaming.
  useEffect(() => {
    if (isStreaming) setStopNotice(null);
  }, [isStreaming]);

  // Classify the turn error into a heading + detail so the banner names the cause
  // (connection reset, timeout, rate limit, context overflow, quota, ...) instead
  // of a generic "Something went wrong". Computed here (not only in the JSX) so
  // the SAME on-screen banner text can be mirrored into the export (issue #160).
  const errorView = error ? describeChatError(error.message ?? "", t) : null;

  // Report the live turn-token total to the parent header badge, THROTTLED to
  // ~8 Hz so the parent re-renders a few times a second instead of on every
  // streamed delta. The tail assistant message's reasoning+output (estimate while
  // streaming, authoritative once a step reports usage) is the live figure. When
  // the turn ends we emit a final exact value, then `null` so the parent reverts
  // the badge to the persisted context size.
  const lastEmitRef = useRef(0);
  const emitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!onLiveTurnTokens) return;
    if (!isStreaming) {
      // Turn ended (or never started): clear any pending throttle and revert.
      if (emitTimerRef.current) {
        clearTimeout(emitTimerRef.current);
        emitTimerRef.current = null;
      }
      lastEmitRef.current = 0;
      onLiveTurnTokens(null);
      return;
    }
    const tail = messages[messages.length - 1];
    const live = tail?.role === "assistant" ? liveTurnTokens(tail) : null;
    const total = live ? live.reasoning + live.output : 0;
    const now = Date.now();
    const MIN_INTERVAL = 120; // ms (~8 Hz)
    const elapsed = now - lastEmitRef.current;
    if (elapsed >= MIN_INTERVAL) {
      lastEmitRef.current = now;
      onLiveTurnTokens(total);
    } else if (!emitTimerRef.current) {
      // Schedule a trailing emit so the FINAL value of a burst is not dropped.
      emitTimerRef.current = setTimeout(() => {
        emitTimerRef.current = null;
        lastEmitRef.current = Date.now();
        onLiveTurnTokens(total);
      }, MIN_INTERVAL - elapsed);
    }
  }, [messages, isStreaming, onLiveTurnTokens]);

  // Clear any pending throttle timer on unmount (chat switch via `key`) so a
  // trailing emit can't fire into a torn-down thread's parent.
  useEffect(() => {
    return () => {
      if (emitTimerRef.current) clearTimeout(emitTimerRef.current);
    };
  }, []);

  // A role was picked with autoStart=false: the role is bound but NOTHING was
  // sent, so chatId stays null and the empty state would keep showing the cards.
  // This flag hides the cards and reveals the composer (with the role indicated)
  // so the user can type the first message themselves. roleIdRef is already set,
  // so that first manual message carries the roleId.
  const [rolePickedNoSend, setRolePickedNoSend] = useState(false);

  // Clicking a role card always binds the role to THIS new chat. Whether it also
  // auto-starts the conversation is per-role (autoStart). roleIdRef is set
  // synchronously here because the parent's selectedRoleId state update would
  // only reach roleIdRef on the next render — after this synchronous sendMessage
  // has already read it.
  const handleRolePick = (role: IAiRole): void => {
    roleIdRef.current = role.id;
    onRolePicked?.(role);
    const launch = roleLaunchMessage(
      role,
      t("Take a look at the current document"),
    );
    if (launch !== null) {
      sendMessage({ text: launch });
    } else {
      // autoStart=false -> bind only: hide the cards, show the composer.
      setRolePickedNoSend(true);
    }
  };
  // Reset the "picked, not sent" flag when the thread returns to a truly empty,
  // role-less state — e.g. the user hit "New chat" after picking an autoStart=false
  // role. That path clears the parent's selectedRoleId (roleId -> null) but leaves
  // chatId null, so the thread never remounts and the flag would stay set, hiding
  // the cards forever. A picked-and-bound role keeps roleId non-null, so the cards
  // correctly stay hidden then. Render-phase reset (React "adjust state on prop
  // change"): one-shot — it re-renders with the flag false and the guard no longer
  // matches, so it cannot loop. (Review of #149.)
  if (shouldResetRolePicked(chatId, roleId, rolePickedNoSend)) {
    setRolePickedNoSend(false);
  }
  const showRoleCards =
    chatId === null && (roles?.length ?? 0) > 0 && !rolePickedNoSend;
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

      {errorView ? (
        <ChatErrorAlert
          title={errorView.title}
          detail={errorView.detail}
          mb="xs"
        />
      ) : stopNotice ? (
        <ChatStoppedNotice
          text={
            stopNotice === "manual"
              ? t("Response stopped.")
              : t("Connection lost — the answer was interrupted.")
          }
          mb="xs"
        />
      ) : null}

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
