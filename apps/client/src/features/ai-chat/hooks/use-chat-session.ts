import { useCallback, useEffect, useReducer, useRef } from "react";
import { generateId } from "ai";
import {
  resolveAdoptedChatId,
  newlyAddedChatIds,
} from "@/features/ai-chat/utils/adopt-chat-id.ts";
import {
  newThread,
  switchThread,
  threadSessionReducer,
} from "@/features/ai-chat/utils/thread-identity.ts";

/** Inputs to {@link useChatSession}. `activeChatId`/`setActiveChatId` are the
 *  public selection atom (also written from outside the window, e.g. page
 *  history); the rest is read-only context the hook needs. */
export interface UseChatSessionOptions {
  activeChatId: string | null;
  setActiveChatId: (id: string | null) => void;
  chats: { items?: { id: string }[] } | undefined;
  messagesLoading: boolean;
  /** Wraps queryClient.invalidateQueries(AI_CHATS_RQ_KEY). */
  onInvalidateChatList: () => void;
  /** Wraps the per-chat messages invalidation. */
  onInvalidateChatMessages: (chatId: string) => void;
}

/** What the window needs from a chat session: the ChatThread mount key, the
 *  history-loader gate, and the turn-finished callback. */
export interface UseChatSessionResult {
  /** ChatThread mount key (was `thread.key`). */
  threadKey: string;
  /** Show the history loader instead of the live thread. */
  waitingForHistory: boolean;
  /** Call when a turn finishes; `serverChatId` is the authoritative streamed id
   *  (undefined on a failed turn). Handles new-chat id adoption + invalidations. */
  onTurnFinished: (serverChatId?: string) => void;
  /** Call EARLY (at the stream's `start` chunk) with the authoritative streamed
   *  chat id so a brand-new chat adopts its real id WHILE its first turn is still
   *  streaming — making `activeChatId`-gated affordances (e.g. the Copy/export
   *  button, #174) available immediately. In-place adoption only (same mount key,
   *  no list/messages invalidation — that is left to onTurnFinished at the end).
   *  Idempotent and a no-op once the chat already has an id. */
  onServerChatId: (serverChatId?: string) => void;
  /** Disarm any pending error-path new-chat fallback. The window calls this from
   *  startNewChat/selectChat so a late refetch can't yank the user back into a
   *  just-failed chat after they explicitly moved on. */
  cancelPendingAdoption: () => void;
}

/** Project a chat list to its id array (the before/after snapshot for the
 *  error-path fallback). */
function chatIdSnapshot(
  chats: { items?: { id: string }[] } | undefined,
): string[] {
  return chats?.items?.map((c) => c.id) ?? [];
}

/**
 * Owns the AI-chat thread-identity lifecycle: the single atomic thread identity,
 * both new-chat id adoption paths (primary streamed-metadata + bounded error-path
 * fallback), the history-loaded latch, and the render-phase reconciler that keeps
 * the thread's mount key in sync with the public `activeChatId` atom.
 *
 * This is the twice-bugged area for the #137 two-tab adoption race; the canonical
 * explanation of the adoption design lives in adopt-chat-id.ts.
 */
export function useChatSession(
  params: UseChatSessionOptions,
): UseChatSessionResult {
  const {
    activeChatId,
    setActiveChatId,
    chats,
    messagesLoading,
    onInvalidateChatList,
    onInvalidateChatMessages,
  } = params;

  // Live mirror of `activeChatId`, read by onTurnFinished. ai@6 fires both
  // onFinish AND onError on a failed turn, so onTurnFinished can run twice in one
  // turn (once with the streamed id, once without) BEFORE a re-render. Reading
  // the ref — which the primary-adoption branch updates imperatively — makes that
  // second call see the just-adopted id, so it cannot re-arm the fallback. (A
  // plain closure over `activeChatId` would still read null on the second call.)
  const activeChatIdRef = useRef(activeChatId);
  activeChatIdRef.current = activeChatId;

  // The mounted thread's identity: ONE atomic value tying ChatThread's mount key
  // (`thread.key`) to the chat id that mounted thread holds (`thread.chatId`).
  // Consolidating these makes the "key vs chat id diverged" state unrepresentable
  // — every change goes through an explicit transition (see thread-identity.ts):
  // `newThread`/`switchThread` to (re)mount, `adoptThread` for in-place adoption.
  // Initial: a non-null activeChatId switches to it; a null one gets a fresh
  // session key with no chat id yet.
  const [thread, dispatch] = useReducer(threadSessionReducer, undefined, () =>
    activeChatId === null
      ? newThread(`new-${generateId()}`)
      : switchThread(activeChatId),
  );

  // Error-path fallback for new-chat id adoption. When a brand-new chat's first
  // turn errors BEFORE the server's `start` chunk, no authoritative chatId ever
  // reaches the client, so the primary metadata adoption cannot run. We then ARM
  // this ref with a snapshot of the currently-known chat ids; once the list
  // refetch lands with the just-created row, the fallback effect below adopts the
  // SINGLE newly-appeared id. `null` = not armed. See adopt-chat-id.ts (#137).
  const pendingNewChatRef = useRef<string[] | null>(null);

  // Latch: the chat id whose full persisted history has finished loading while
  // its thread is mounted. Used so a later BACKGROUND refetch (the post-turn
  // messages invalidation) never tears the live thread back down to the loader.
  const historyLoadedKeyRef = useRef<string | null>(null);

  // After a turn finishes, refresh the chat list. For a brand-new chat (no id
  // yet) we adopt the server's AUTHORITATIVE streamed id (never the newest in the
  // list, which races a second tab — #137; see adopt-chat-id.ts).
  const onTurnFinished = useCallback(
    (serverChatId?: string) => {
      // Read the live id from the ref, not the closure: on a failed turn this can
      // run twice in one turn (onFinish + onError) before any re-render, and the
      // primary branch below updates the ref so the second call sees the adopted id.
      const current = activeChatIdRef.current;
      const adopted = resolveAdoptedChatId(current, serverChatId);
      if (adopted) {
        // PRIMARY path. In-place adoption: set the public selection and the
        // thread identity to the real id together. `adopt` keeps the SAME mount
        // key, so the render-phase reconciler sees `activeChatId === thread.chatId`
        // and keeps the SAME mounted thread (its useChat already holds the
        // just-finished turn) instead of remounting + re-seeding from
        // not-yet-persisted history.
        activeChatIdRef.current = adopted; // a same-turn 2nd call now sees the id
        setActiveChatId(adopted);
        dispatch({ type: "adopt", chatId: adopted });
        // Primary adoption won — disarm any previously-armed fallback.
        pendingNewChatRef.current = null;
      } else if (current === null) {
        // FALLBACK path: a brand-new chat finished with NO server id (the first
        // turn errored before the `start` chunk). Arm the bounded list-refetch
        // fallback by snapshotting the currently-known chat ids. `chats` is still
        // the pre-refetch list here, so the just-created row is NOT yet in it; the
        // effect below adopts the single id that newly appears after the refetch.
        pendingNewChatRef.current = chatIdSnapshot(chats);
      }
      onInvalidateChatList();
      // Re-sync the persisted message rows for the active chat so the Markdown
      // export and token counters reflect the just-finished turn. The live thread
      // renders from its own useChat store (stable thread.key), so this never
      // re-seeds or tears down the open thread. For a brand-new chat `current` is
      // still null here; later turns hit this with the adopted id.
      if (current) {
        onInvalidateChatMessages(current);
      }
    },
    [chats, setActiveChatId, onInvalidateChatList, onInvalidateChatMessages],
  );

  // EARLY adoption (#174): adopt the authoritative streamed chat id the moment
  // the server emits it on the `start` chunk, so a brand-new chat gets its real
  // `activeChatId` WHILE its first turn streams — not only at terminal
  // onTurnFinished. This makes the activeChatId-gated Copy/export button
  // available during the first turn. Pure in-place adoption (same mount key, like
  // the primary path) with NO invalidation: the list/messages refresh stays on
  // onTurnFinished at the end of the turn. Reads the live id from the ref so a
  // repeat call after adoption is a no-op (resolveAdoptedChatId only fires for a
  // still-new chat).
  const onServerChatId = useCallback(
    (serverChatId?: string) => {
      const adopted = resolveAdoptedChatId(
        activeChatIdRef.current,
        serverChatId,
      );
      if (!adopted) return;
      activeChatIdRef.current = adopted;
      setActiveChatId(adopted);
      dispatch({ type: "adopt", chatId: adopted });
      // Early adoption beat the error-path fallback to it — disarm.
      pendingNewChatRef.current = null;
    },
    [setActiveChatId],
  );

  // FALLBACK resolver. Armed only by onTurnFinished when a brand-new chat's first
  // turn errored before the `start` chunk (no authoritative id streamed). Once
  // the per-user list refetch lands with the just-created row, adopt the SINGLE
  // id that newly appeared relative to the pre-refetch snapshot. Adoption is IN
  // PLACE (set activeChatId + `adopt` together) like the primary path, so the
  // render-phase reconciler does not remount.
  useEffect(() => {
    const before = pendingNewChatRef.current;
    if (before === null || activeChatId !== null) return; // not armed / already adopted
    const after = chatIdSnapshot(chats);
    const added = newlyAddedChatIds(before, after);
    // Keep waiting until a genuinely-new id appears. Set-based, so it is robust
    // to an add+delete in the same window (a length compare would miss it), and
    // it deliberately keeps waiting through an unrelated deletion (no new id yet)
    // until the just-created row actually lands, rather than giving up early.
    if (added.size === 0) return; // list not refetched yet — keep waiting
    pendingNewChatRef.current = null; // resolved — disarm
    if (added.size === 1) {
      // single unambiguous new id; >1 = ambiguous → give up
      const adopted = [...added][0];
      setActiveChatId(adopted);
      dispatch({ type: "adopt", chatId: adopted });
    }
  }, [chats, activeChatId, setActiveChatId]);

  // Reconcile the thread identity against the active-chat atom during render when
  // they diverge — the React-sanctioned alternative to an effect (re-renders
  // before paint, no extra commit, and converges since the next render finds them
  // equal). This reconciliation MUST remain: `activeChatId` is the public
  // selection and is ALSO set from OUTSIDE this component (e.g. page-history opens
  // a referenced chat via setActiveChatId). A divergence here is a genuine SWITCH
  // (external atom change OR user switch via selectChat/startNewChat), so
  // `reconcile` remounts + reseeds. In-place adoption never reaches this branch:
  // it set activeChatId and thread.chatId to the same value.
  if (activeChatId !== thread.chatId) {
    // A genuine switch makes any pending error-path new-chat fallback moot.
    pendingNewChatRef.current = null;
    dispatch({
      type: "reconcile",
      chatId: activeChatId,
      newKey: `new-${generateId()}`,
    });
  }

  // Latch the active chat once its full history has loaded and its thread is
  // mounted, so a later background refetch (the post-turn messages invalidation,
  // which can transiently flip hasNextPage for a chat whose message count is an
  // exact multiple of the server page size) does not tear the live thread down to
  // a loader and lose its in-progress useChat state.
  if (
    activeChatId !== null &&
    thread.key === activeChatId &&
    !messagesLoading &&
    historyLoadedKeyRef.current !== activeChatId
  ) {
    historyLoadedKeyRef.current = activeChatId;
  }

  // Show the history loader only when freshly OPENING an existing chat (the key
  // equals the chat id) whose history has not been fully loaded yet. For a live
  // in-place thread that adopted its id, the key is still the "new-…" session
  // key, so the live thread keeps rendering; and once a chat's history has loaded,
  // a later background refetch no longer tears it down (see the latch above).
  const waitingForHistory =
    activeChatId !== null &&
    messagesLoading &&
    thread.key === activeChatId &&
    historyLoadedKeyRef.current !== activeChatId;

  // Explicit disarm for startNewChat/selectChat. The render-phase reconciler only
  // disarms when activeChatId actually changes, but "New chat" pressed while the
  // user is ALREADY in a new chat is a no-op for the atom (activeChatId stays
  // null), so the reconciler never fires — without this an armed fallback could
  // adopt the just-failed chat from a late refetch and yank the user out of their
  // fresh chat. Stable identity (writes a ref).
  const cancelPendingAdoption = useCallback(() => {
    pendingNewChatRef.current = null;
  }, []);

  return {
    threadKey: thread.key,
    waitingForHistory,
    onTurnFinished,
    onServerChatId,
    cancelPendingAdoption,
  };
}
