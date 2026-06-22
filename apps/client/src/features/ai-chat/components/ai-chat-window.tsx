import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { generateId } from "ai";
import { type UIMessage } from "@ai-sdk/react";
import { Group, Loader, Tooltip } from "@mantine/core";
import {
  IconArrowsDiagonal,
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconGripVertical,
  IconMinus,
  IconPlus,
  IconX,
} from "@tabler/icons-react";
import { useAtom, useSetAtom } from "jotai";
import { useMatch } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  activeAiChatIdAtom,
  aiChatWindowOpenAtom,
  aiChatWindowGeomAtom,
  aiChatDraftAtom,
  selectedAiRoleIdAtom,
} from "@/features/ai-chat/atoms/ai-chat-atom.ts";
import { usePageQuery } from "@/features/page/queries/page-query.ts";
import { extractPageSlugId } from "@/lib";
import {
  AI_CHATS_RQ_KEY,
  AI_CHAT_MESSAGES_RQ_KEY,
  useAiChatMessagesQuery,
  useAiChatsQuery,
  useAiRolesQuery,
} from "@/features/ai-chat/queries/ai-chat-query.ts";
import ConversationList from "@/features/ai-chat/components/conversation-list.tsx";
import ChatThread from "@/features/ai-chat/components/chat-thread.tsx";
import { buildChatMarkdown } from "@/features/ai-chat/utils/chat-markdown.ts";
import {
  resolveAdoptedChatId,
  pickNewlyCreatedChatId,
} from "@/features/ai-chat/utils/adopt-chat-id.ts";
import {
  shouldCollapseOnOutsidePointer,
  isHeaderClick,
} from "@/features/ai-chat/utils/collapse-helpers.ts";
import { useClipboard } from "@/hooks/use-clipboard";
import { notifications } from "@mantine/notifications";
import classes from "@/features/ai-chat/components/ai-chat-window.module.css";

// Default window dimensions (wider default per user request); both are
// clamped to the viewport in computeInitialGeom().
const DEFAULT_WIDTH = 540;
const DEFAULT_HEIGHT = 680;
// CSS-enforced minimum window size (ai-chat-window.module.css). The geometry
// math must respect these so the real box is clamped within the viewport.
const MIN_WIDTH = 300;
const MIN_HEIGHT = 400;
// Margin kept between the window and the viewport edges while dragging.
const EDGE_MARGIN = 8;

/** Compact token formatter: 1.2M / 3.4k / 950. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Compute the initial top-right placement at the default size, fitted to the
// current viewport. Reads `window` only when called (inside an effect).
function computeInitialGeom() {
  const width = Math.max(
    MIN_WIDTH,
    Math.min(DEFAULT_WIDTH, window.innerWidth - 2 * EDGE_MARGIN),
  );
  const height = Math.max(
    MIN_HEIGHT,
    Math.min(DEFAULT_HEIGHT, window.innerHeight - 2 * EDGE_MARGIN),
  );
  const left = Math.max(EDGE_MARGIN, window.innerWidth - width - 24);
  const maxTop = Math.max(EDGE_MARGIN, window.innerHeight - height - EDGE_MARGIN);
  const top = Math.min(60, maxTop);
  return { left, top, width, height };
}

// Clamp a geometry so the window stays within the current viewport.
function clampGeom(g: { left: number; top: number; width: number; height: number }) {
  const effWidth = Math.max(g.width, MIN_WIDTH);
  const effHeight = Math.max(g.height, MIN_HEIGHT);
  const maxLeft = Math.max(EDGE_MARGIN, window.innerWidth - effWidth - EDGE_MARGIN);
  const maxTop = Math.max(EDGE_MARGIN, window.innerHeight - effHeight - EDGE_MARGIN);
  return {
    ...g,
    left: Math.min(Math.max(EDGE_MARGIN, g.left), maxLeft),
    top: Math.min(Math.max(EDGE_MARGIN, g.top), maxTop),
  };
}

/**
 * Floating, draggable, resizable, minimizable AI chat window. Replaces the
 * former right-aside `AiChatPanel`: it owns ALL chat orchestration (active
 * chat, new chat, in-place id adoption from streamed metadata, open-page
 * context, token sum) and wraps the
 * reused inner components (ConversationList + ChatThread) in window chrome
 * ported from the GitmostAgent.jsx design.
 */
export default function AiChatWindow() {
  const { t } = useTranslation();
  const clipboard = useClipboard({ timeout: 500 });
  const queryClient = useQueryClient();
  const [windowOpen, setWindowOpen] = useAtom(aiChatWindowOpenAtom);
  const [activeChatId, setActiveChatId] = useAtom(activeAiChatIdAtom);
  const setDraft = useSetAtom(aiChatDraftAtom);
  // The role chosen for the next new chat (null = universal assistant).
  const [selectedRoleId, setSelectedRoleId] = useAtom(selectedAiRoleIdAtom);

  // History section starts collapsed (matches the former panel's behavior).
  const [historyOpen, setHistoryOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  // Mirror of `minimized` for handlers wrapped in useCallback([]) (startDrag),
  // which would otherwise close over a stale value. Kept in sync below.
  const minimizedRef = useRef(minimized);
  minimizedRef.current = minimized;

  const winRef = useRef<HTMLDivElement>(null);
  // Live window geometry (position + size); persisted to localStorage so a
  // drag/resize survives a full page reload (and close/reopen). `null` means
  // "never placed yet" — the layout effect below then computes an initial
  // top-right placement anchored to the current viewport, and on restore it is
  // re-clamped to the viewport (so a placement saved on a larger screen is not
  // left partly off-screen).
  const [geom, setGeom] = useAtom(aiChatWindowGeomAtom);

  // Latch: the chat id whose full persisted history has finished loading while
  // its thread is mounted. Used so a later BACKGROUND refetch (the post-turn
  // messages invalidation) never tears the live thread back down to the loader.
  const historyLoadedKeyRef = useRef<string | null>(null);

  // Error-path fallback for new-chat id adoption. When a brand-new chat's first
  // turn errors BEFORE the server's `start` chunk, no authoritative chatId ever
  // reaches the client, so the primary metadata adoption cannot run. We then
  // ARM this ref with a snapshot of the currently-known chat ids; once the list
  // refetch lands with the just-created row, the fallback effect below adopts
  // the SINGLE newly-appeared id (unambiguous — unlike the old items[0] guess).
  // `null` = not armed.
  const pendingNewChatRef = useRef<string[] | null>(null);

  // Mount key for ChatThread + the chat the currently-mounted thread represents.
  // `threadKey` normally tracks the active chat, so selecting a different chat
  // (incl. from page history) remounts and re-seeds. The ONE exception is
  // in-place adoption of a brand-new chat's server id: the adopt effect moves
  // `liveThreadChatId` to the new id TOGETHER with `activeChatId`, so the switch
  // check below does not fire and the SAME thread stays mounted (its useChat
  // already holds the just-finished turn) instead of being re-seeded from
  // not-yet-persisted history.
  const [threadKey, setThreadKey] = useState<string>(
    () => activeChatId ?? `new-${generateId()}`,
  );
  const [liveThreadChatId, setLiveThreadChatId] = useState<string | null>(
    activeChatId,
  );

  const { data: chats } = useAiChatsQuery();
  // Roles for the new-chat picker (any member may list them). Only fetched while
  // the window is open.
  const { data: roles } = useAiRolesQuery(windowOpen);
  // The new-chat picker only offers ENABLED roles. The list endpoint returns
  // all live roles (so the admin settings section can manage disabled ones), so
  // we filter to `enabled` here, client-side, for the composer picker only.
  const enabledRoles = useMemo(
    () => (roles ?? []).filter((r) => r.enabled === true),
    [roles],
  );

  const { data: messageRows, isLoading: messagesLoading } =
    useAiChatMessagesQuery(activeChatId ?? undefined);

  // Live snapshot of the active thread's useChat state, kept up to date by
  // ChatThread. Lets the export include the in-progress (not-yet-persisted)
  // streaming turn. A ref avoids re-rendering this window on every token.
  const liveThreadRef = useRef<{ messages: UIMessage[]; isStreaming: boolean }>({
    messages: [],
    isStreaming: false,
  });

  // The page the user is currently viewing. AiChatWindow lives in a pathless
  // parent layout route, so useParams() can't see :pageSlug. Match the full
  // pathname against the authenticated page route instead so "the current page"
  // resolves regardless of where this component is mounted. On a non-page route
  // the match is null, so `pageSlug` is undefined, the query is disabled and
  // `openPage` is null. This is passed to the chat thread as context so the
  // agent knows what "this page"/"the current page" refers to; the agent still
  // reads/writes via its CASL-enforced page tools using the id.
  const pageRouteMatch = useMatch("/s/:spaceSlug/p/:pageSlug");
  const pageSlug = pageRouteMatch?.params?.pageSlug;
  const { data: openPageData } = usePageQuery({
    pageId: extractPageSlugId(pageSlug),
  });
  const openPage = openPageData
    ? { id: openPageData.id, title: openPageData.title }
    : null;

  const startNewChat = useCallback((): void => {
    setActiveChatId(null);
    setHistoryOpen(false);
    setDraft("");
    // Default the picker back to "Universal assistant" for the fresh chat.
    setSelectedRoleId(null);
    // The user moved on — disarm any pending error-path adoption fallback.
    pendingNewChatRef.current = null;
  }, [setActiveChatId, setDraft, setSelectedRoleId]);

  const selectChat = useCallback(
    (chatId: string): void => {
      setActiveChatId(chatId);
      setHistoryOpen(false);
      setDraft("");
      // Reset the card-picked role so a stale pick can't leak into the existing
      // chat's header/assistant-name (which prefers the chat's persisted role).
      setSelectedRoleId(null);
      // The user moved on — disarm any pending error-path adoption fallback.
      pendingNewChatRef.current = null;
    },
    [setActiveChatId, setDraft, setSelectedRoleId],
  );

  // After a turn finishes, refresh the chat list. For a brand-new chat (no id
  // yet), the server has just created the row and reported its AUTHORITATIVE id
  // via the streamed assistant message metadata (`serverChatId`); we adopt THAT
  // exact id so the thread switches from "new" to its OWN persisted chat — never
  // guessing the newest chat in the list, which would adopt a SIBLING chat that
  // a second tab created in the same moment and leak this tab's later turns into
  // it (the two-tab adoption race, #137).
  const onTurnFinished = useCallback(
    (serverChatId?: string) => {
      const adopted = resolveAdoptedChatId(activeChatId, serverChatId);
      if (adopted) {
        // PRIMARY path. In-place adoption: move the active chat AND the
        // live-thread marker to the real id together, so the render-phase switch
        // check below sees no "switch" and keeps the SAME mounted thread (its
        // useChat already holds the just-finished turn, and its chatIdRef now
        // mirrors the real id so the SECOND turn sends the correct chatId)
        // instead of remounting and re-seeding from not-yet-persisted history.
        // React's automatic batching inside this callback lands both updates in
        // one render, so the guard never observes the new activeChatId with a
        // stale liveThreadChatId.
        setLiveThreadChatId(adopted);
        setActiveChatId(adopted);
        // Primary adoption won — disarm any previously-armed fallback.
        pendingNewChatRef.current = null;
      } else if (activeChatId === null) {
        // FALLBACK path: a brand-new chat finished with NO server id (the first
        // turn errored before the `start` chunk). Arm the bounded list-refetch
        // fallback by snapshotting the currently-known chat ids. `chats` is still
        // the pre-refetch list here, so the just-created row is NOT yet in it; the
        // effect below adopts the single id that newly appears after the refetch.
        pendingNewChatRef.current = chats?.items?.map((c) => c.id) ?? [];
      }
      queryClient.invalidateQueries({ queryKey: AI_CHATS_RQ_KEY });
      // Re-sync the persisted message rows for the active chat so the Markdown
      // export and the token counters reflect the turn that just finished. The
      // live thread renders from its own useChat store (stable threadKey / store
      // id), so refetching these rows never re-seeds or tears down the open
      // thread. For a brand-new chat activeChatId is still null here; that chat's
      // first row load happens right after id adoption, and every later turn hits
      // this invalidation with the adopted id.
      if (activeChatId) {
        queryClient.invalidateQueries({
          queryKey: AI_CHAT_MESSAGES_RQ_KEY(activeChatId),
        });
      }
    },
    [activeChatId, chats, queryClient, setActiveChatId],
  );

  // FALLBACK resolver. Armed only by onTurnFinished when a brand-new chat's
  // first turn errored before the `start` chunk (no authoritative id streamed).
  // Once the per-user list refetch lands with the just-created row, adopt the
  // SINGLE id that newly appeared relative to the pre-refetch snapshot. Adoption
  // is IN PLACE (move liveThreadChatId + activeChatId together) exactly like the
  // primary path, so the render-phase switch guard does not remount the thread.
  useEffect(() => {
    const before = pendingNewChatRef.current;
    if (before === null || activeChatId !== null) return; // not armed / already adopted
    const after = chats?.items?.map((c) => c.id) ?? [];
    // Keep waiting until the list membership actually CHANGES (the refetch
    // landed). A length compare would miss the change if another session
    // concurrently deleted a chat in this same window (length stays equal while
    // a new row was added); a set-membership compare is robust to that.
    const beforeSet = new Set(before);
    if (after.length === before.length && after.every((id) => beforeSet.has(id)))
      return; // list not refetched yet — keep waiting
    const adopted = pickNewlyCreatedChatId(before, after); // single new id, or null if ambiguous
    pendingNewChatRef.current = null; // give up after one resolved refetch either way
    if (adopted) {
      setLiveThreadChatId(adopted);
      setActiveChatId(adopted);
    }
  }, [chats, activeChatId, setActiveChatId]);

  // The active chat object (for its title) and an export gate: only enable the
  // export button when an existing chat with loaded persisted rows is active.
  const activeChat = useMemo(
    () => chats?.items?.find((c) => c.id === activeChatId) ?? null,
    [chats, activeChatId],
  );
  const canExport = !!activeChatId && !!messageRows && messageRows.length > 0;

  // The role to display in the header and as the assistant's name. Prefer the
  // persisted role of an existing chat (chat-list JOIN); fall back to the role
  // picked via a card click for a brand-new or just-adopted chat. selectChat
  // resets selectedRoleId, so this fallback never leaks into an unrelated chat.
  const currentRole = useMemo<{ name: string; emoji: string | null } | null>(() => {
    if (activeChat?.roleName) {
      return { name: activeChat.roleName, emoji: activeChat.roleEmoji ?? null };
    }
    const picked = enabledRoles.find((r) => r.id === selectedRoleId);
    return picked ? { name: picked.name, emoji: picked.emoji } : null;
  }, [activeChat, enabledRoles, selectedRoleId]);

  // Build a Markdown export from the already-loaded persisted rows (no network
  // call) and copy it to the clipboard. The "Copied" notification is the
  // feedback.
  const handleCopy = useCallback(() => {
    if (!activeChatId || !messageRows || messageRows.length === 0) return;
    // While the active thread is streaming, the current user message and the
    // in-progress assistant reply are NOT yet in messageRows (the persisted
    // query is only refetched after the turn finishes). Pull the live tail —
    // messages whose id is not among the persisted rows — and append them,
    // flagging the streaming assistant message as still generating.
    const live = liveThreadRef.current;
    const rowIds = new Set(messageRows.map((r) => r.id));
    const pending = live.isStreaming
      ? live.messages
          .filter((m) => !rowIds.has(m.id))
          .map((m) => ({
            role: m.role,
            parts: (m.parts ?? []) as { type: string; text?: string }[],
            generating: m.role === "assistant",
          }))
      : [];
    const markdown = buildChatMarkdown({
      title: activeChat?.title ?? null,
      chatId: activeChatId,
      rows: messageRows,
      pending,
      t,
    });
    clipboard.copy(markdown);
    notifications.show({ message: t("Copied") });
  }, [activeChatId, messageRows, activeChat, clipboard, t]);

  // NOTE: new-chat id adoption has two paths, neither of which is the old
  // "newest chat in the list" heuristic that raced a second tab (#137).
  // PRIMARY: the server reports the authoritative created chat id on the streamed
  // assistant message metadata, and `onTurnFinished(serverChatId)` adopts THAT id
  // in place — see above. FALLBACK (only when the first turn errors before the
  // `start` chunk, so no metadata id is streamed): adopt the SINGLE chat that
  // newly appeared in the refetched per-user list relative to a pre-refetch
  // snapshot taken when the failed turn finished — unambiguous, and it does not
  // race a sibling chat the way `items[0]` did (see the fallback effect above).

  // Adjust the derived thread state during render when the active chat genuinely
  // changes — the React-sanctioned alternative to an effect (it re-renders before
  // paint, no extra commit, and converges since the next render finds them equal).
  // In-place adoption of a new chat's id never reaches here because the adopt
  // effect moves liveThreadChatId in lockstep with activeChatId.
  if (activeChatId !== liveThreadChatId) {
    setLiveThreadChatId(activeChatId);
    setThreadKey(activeChatId ?? `new-${generateId()}`);
  }
  // Latch the active chat once its full history has loaded and its thread is
  // mounted, so a later background refetch (the post-turn messages
  // invalidation, which can transiently flip hasNextPage for a chat whose
  // message count is an exact multiple of the server page size) does not tear
  // the live thread down to a loader and lose its in-progress useChat state.
  if (
    activeChatId !== null &&
    threadKey === activeChatId &&
    !messagesLoading &&
    historyLoadedKeyRef.current !== activeChatId
  ) {
    historyLoadedKeyRef.current = activeChatId;
  }

  // Show the history loader only when freshly OPENING an existing chat (the key
  // equals the chat id) whose history has not been fully loaded yet. For a live
  // in-place thread that adopted its id, the key is still the "new-…" session
  // key, so we keep showing the live thread instead of unmounting it behind a
  // loader; and once a chat's history has loaded, a later background refetch no
  // longer tears the thread back down (see the latch above).
  const waitingForHistory =
    activeChatId !== null &&
    messagesLoading &&
    threadKey === activeChatId &&
    historyLoadedKeyRef.current !== activeChatId;

  // Current context size for the active chat: how much the conversation now
  // occupies in the model's context window — NOT the cumulative tokens spent.
  // We read the most recent assistant row that carries a context figure:
  // `contextTokens` (final-step input+output) for chats recorded after this
  // shipped; older rows fall back to that turn's `usage` total. NOTE: reflects
  // PERSISTED rows (updates on chat open/switch); it does not tick live
  // mid-stream — acceptable for v1.
  const contextTokens = useMemo(() => {
    if (!activeChatId || !messageRows) return 0;
    for (let i = messageRows.length - 1; i >= 0; i--) {
      const meta = messageRows[i].metadata;
      if (!meta) continue;
      if (typeof meta.contextTokens === "number" && meta.contextTokens > 0) {
        return meta.contextTokens;
      }
      const usage = meta.usage;
      if (usage) {
        const fallback =
          usage.totalTokens ??
          (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        if (fallback > 0) return fallback;
      }
    }
    return 0;
  }, [activeChatId, messageRows]);

  // On (re)open, settle the geometry before paint (useLayoutEffect → no
  // first-frame jump): compute an initial top-right placement the first time,
  // and re-clamp an existing geometry to the current viewport on later opens
  // (so a stale placement is not left partly off-screen after a viewport
  // shrink). setGeom here does not loop — windowOpen is unchanged by it.
  useLayoutEffect(() => {
    if (!windowOpen) return;
    setGeom((prev) => (prev ? clampGeom(prev) : computeInitialGeom()));
    // Always show the window expanded on (re)open: a collapsed state from a
    // previous open session must not stick. Runs before paint so the first
    // frame is already expanded. The composer's autofocus is a focus INSIDE the
    // window (not an outside mousedown), so it cannot self-collapse the window.
    setMinimized(false);
  }, [windowOpen]);

  // Auto-collapse the window into its header as soon as the user interacts with
  // anything outside it (clicks the page/editor). Armed ONLY while the window is
  // open and expanded, so it never fires repeatedly and never collapses on the
  // open→reset transition. Capture phase so a page handler's stopPropagation in
  // the bubble phase can't hide the event from us; the in-window/portal guards
  // (shouldCollapseOnOutsidePointer) prevent false collapses from clicks inside
  // the window or inside Mantine portals (kebab menu, delete-confirm modal).
  useEffect(() => {
    if (!windowOpen || minimized) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (shouldCollapseOnOutsidePointer(e.target, winRef.current)) {
        setMinimized(true);
      }
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [windowOpen, minimized]);

  // Persist the user's resize into state so it survives close/reopen. Skipped
  // while minimized so the collapsed (auto) height is never captured. The
  // equality guard avoids an update loop.
  useEffect(() => {
    if (!windowOpen || minimized) return;
    const el = winRef.current;
    // `geom` is in the deps so this re-runs once geometry is settled and the
    // window is actually rendered (on the first open `geom` is still null on the
    // render that flips windowOpen, so winRef.current is null then — without the
    // geom dep the observer would never attach and resizes would not persist).
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      setGeom((prev) => {
        if (!prev || (prev.width === width && prev.height === height)) return prev;
        return { ...prev, width, height };
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [windowOpen, minimized, geom !== null]);

  const startDrag = useCallback((e: React.MouseEvent): void => {
    // Ignore drags that originate on a button (minimize/close/new chat).
    if ((e.target as HTMLElement).closest("button")) return;
    const el = winRef.current;
    if (!el) return;

    const sx = e.clientX;
    const sy = e.clientY;
    const ol = parseFloat(el.style.left) || 0;
    const ot = parseFloat(el.style.top) || 0;

    const move = (ev: MouseEvent): void => {
      let nl = ol + (ev.clientX - sx);
      let nt = ot + (ev.clientY - sy);
      // Clamp to the viewport (not the parent — the window is mounted globally
      // with position: fixed) with an 8px margin.
      nl = Math.max(
        EDGE_MARGIN,
        Math.min(nl, window.innerWidth - el.offsetWidth - EDGE_MARGIN),
      );
      nt = Math.max(
        EDGE_MARGIN,
        Math.min(nt, window.innerHeight - el.offsetHeight - EDGE_MARGIN),
      );
      el.style.left = `${nl}px`;
      el.style.top = `${nt}px`;
    };

    const up = (ev: MouseEvent): void => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.userSelect = "";
      // Treat a near-zero-movement press as a click (not a drag). When the
      // window is minimized, a header click expands it; nothing to persist
      // because the position did not change. minimizedRef avoids the stale
      // `minimized` captured by useCallback([]).
      if (
        minimizedRef.current &&
        isHeaderClick(sx, sy, ev.clientX, ev.clientY)
      ) {
        setMinimized(false);
        return;
      }
      const el2 = winRef.current;
      // Persist the final position back into state (preserving the size) so
      // re-renders keep it.
      if (el2) {
        setGeom((prev) =>
          prev
            ? {
                ...prev,
                left: parseFloat(el2.style.left) || 0,
                top: parseFloat(el2.style.top) || 0,
              }
            : prev,
        );
      }
    };

    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    document.body.style.userSelect = "none";
    e.preventDefault();
  }, []);

  // Just toggle the flag. The `.minimized` CSS handles the collapsed height and
  // disables resize, and `.minimized .content` hides the body while keeping
  // ChatThread mounted (so an in-flight stream is not aborted).
  const toggleMinimize = useCallback((): void => {
    setMinimized((m) => !m);
  }, []);

  if (!windowOpen || !geom) return null;

  return (
    <div
      ref={winRef}
      className={`${classes.window}${minimized ? ` ${classes.minimized}` : ""}`}
      style={{
        left: geom.left,
        top: geom.top,
        width: geom.width,
        // Height omitted when minimized so the `.minimized` CSS auto-height wins.
        height: minimized ? undefined : geom.height,
      }}
    >
      {/* drag bar / header. Mouse users expand a minimized window by clicking
          anywhere on the bar (the click-vs-drag logic in startDrag, which
          excludes the buttons). The keyboard/screen-reader Expand affordance
          lives on the title element below — NOT on this container — so we never
          nest the Minimize/Close <button>s inside an element with
          role="button" (invalid ARIA: nested interactive controls). */}
      <div className={classes.dragBar} onMouseDown={startDrag}>
        <IconGripVertical
          size={14}
          color="var(--mantine-color-gray-4)"
          style={{ flex: "none" }}
        />
        {/* When minimized, the title doubles as the keyboard Expand button:
            it carries role/tabIndex/aria-label and an Enter/Space handler, and
            unlike the dragBar it contains no nested <button>s. When expanded it
            is a plain, non-focusable label. */}
        <span
          className={classes.title}
          role={minimized ? "button" : undefined}
          tabIndex={minimized ? 0 : undefined}
          aria-label={minimized ? t("Expand") : undefined}
          onKeyDown={
            minimized
              ? (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setMinimized(false);
                  }
                }
              : undefined
          }
        >
          {t("AI chat")}
        </span>

        {/* Role badge (emoji + name). Shows the persisted role of an existing
            chat, or the role picked via a card for a brand-new chat. Hidden for
            a universal (no-role) chat. */}
        {currentRole && (
          <span className={classes.badge} title={t("Agent role")}>
            {currentRole.emoji ? `${currentRole.emoji} ` : ""}
            {currentRole.name}
          </span>
        )}

        <div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
          {contextTokens > 0 && (
            <Tooltip label={t("Current context size")} withArrow>
              <span className={classes.badge}>{formatTokens(contextTokens)}</span>
            </Tooltip>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 1 }}>
          {canExport && (
            <button
              type="button"
              className={classes.headerBtn}
              title={t("Copy chat")}
              aria-label={t("Copy chat")}
              onClick={handleCopy}
            >
              {clipboard.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </button>
          )}
          <button
            type="button"
            className={classes.headerBtn}
            title={t("Minimize")}
            aria-label={t("Minimize")}
            onClick={toggleMinimize}
          >
            <IconMinus size={14} />
          </button>
          <button
            type="button"
            className={classes.headerBtn}
            title={t("Close")}
            aria-label={t("Close")}
            onClick={() => setWindowOpen(false)}
          >
            <IconX size={14} />
          </button>
        </div>
      </div>

      {/* Body is ALWAYS rendered (just hidden via .minimized .content CSS when
          minimized) so ChatThread — and its useChat store/AbortController —
          stays mounted and an in-flight stream is never aborted. */}
      <div className={classes.content}>
        {/* history */}
        <div className={classes.historySection}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 4,
            }}
          >
            <div
              className={classes.historyHeader}
              role="button"
              tabIndex={0}
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((o) => !o)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setHistoryOpen((o) => !o);
                }
              }}
            >
              <IconChevronDown
                size={12}
                style={{
                  transform: historyOpen ? "none" : "rotate(-90deg)",
                  transition: "transform 150ms ease",
                }}
              />
              <span>{t("Chat history")}</span>
            </div>
            <button
              type="button"
              className={classes.newChatBtn}
              title={t("New chat")}
              aria-label={t("New chat")}
              onClick={startNewChat}
            >
              <IconPlus size={11} />
              {t("New chat")}
            </button>
          </div>
          {historyOpen && (
            <div style={{ marginTop: 2 }}>
              <ConversationList
                activeChatId={activeChatId}
                onSelect={selectChat}
              />
            </div>
          )}
        </div>

        {/* The role picker for a NEW chat is rendered as the chat's empty-state
            (colored role cards centered in the empty window) by ChatThread
            itself — clicking a card starts the chat with that role. Once the
            chat exists, its role is fixed and shown as a header badge instead. */}

        {/* body: active chat thread */}
        <div className={classes.body}>
          {waitingForHistory ? (
            <Group justify="center" py="md">
              <Loader size="sm" />
            </Group>
          ) : (
            <ChatThread
              key={threadKey}
              chatId={activeChatId}
              initialRows={activeChatId ? messageRows : []}
              openPage={openPage}
              // Honoured only for a new chat; null = universal assistant.
              roleId={activeChatId === null ? selectedRoleId : null}
              // Role cards are the new-chat empty-state; offered only when this
              // is a brand-new chat. Clicking a card starts the chat with it.
              roles={activeChatId === null ? enabledRoles : undefined}
              onRolePicked={(role) => setSelectedRoleId(role.id)}
              assistantName={currentRole?.name}
              onTurnFinished={onTurnFinished}
              liveStateRef={liveThreadRef}
            />
          )}
        </div>
      </div>

      {/* resize affordance icon (drawn manually; native resizer is hidden) */}
      {!minimized && (
        <span className={classes.resizeHandle}>
          <IconArrowsDiagonal size={12} />
        </span>
      )}
    </div>
  );
}
