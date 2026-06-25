import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { exportAiChat } from "@/features/ai-chat/services/ai-chat-service.ts";
import { useChatSession } from "@/features/ai-chat/hooks/use-chat-session.ts";
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
  const maxTop = Math.max(
    EDGE_MARGIN,
    window.innerHeight - height - EDGE_MARGIN,
  );
  const top = Math.min(60, maxTop);
  return { left, top, width, height };
}

// Clamp a geometry so the window stays within the current viewport.
function clampGeom(g: {
  left: number;
  top: number;
  width: number;
  height: number;
}) {
  const effWidth = Math.max(g.width, MIN_WIDTH);
  const effHeight = Math.max(g.height, MIN_HEIGHT);
  const maxLeft = Math.max(
    EDGE_MARGIN,
    window.innerWidth - effWidth - EDGE_MARGIN,
  );
  const maxTop = Math.max(
    EDGE_MARGIN,
    window.innerHeight - effHeight - EDGE_MARGIN,
  );
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
  const { t, i18n } = useTranslation();
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

  // Live turn-token total (reasoning + output) for the in-flight turn, pushed up
  // (THROTTLED to ~8 Hz inside ChatThread) so the header badge ticks mid-stream.
  // `null` means no turn is in flight -> the badge falls back to the persisted
  // context size below.
  const [liveTurnTokens, setLiveTurnTokens] = useState<number | null>(null);

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

  // The AI-chat thread-identity lifecycle (mount key, both new-chat id adoption
  // paths, the history-loaded latch, the render-phase reconciler) lives in this
  // hook. See adopt-chat-id.ts for the canonical #137 two-tab race explanation.
  // The invalidate closures are passed inline: `onTurnFinished` is read live by
  // useChat's onFinish (never in an effect dep array), so their identity does not
  // matter — no memoization ceremony needed.
  const {
    threadKey,
    waitingForHistory,
    onTurnFinished,
    cancelPendingAdoption,
  } = useChatSession({
    activeChatId,
    setActiveChatId,
    chats,
    messagesLoading,
    onInvalidateChatList: () =>
      queryClient.invalidateQueries({ queryKey: AI_CHATS_RQ_KEY }),
    onInvalidateChatMessages: (id) =>
      queryClient.invalidateQueries({ queryKey: AI_CHAT_MESSAGES_RQ_KEY(id) }),
  });

  // startNewChat/selectChat set the public atom; the hook's render-phase
  // reconciler handles the remount when activeChatId actually CHANGES. But
  // pressing "New chat" while already in a new chat leaves activeChatId === null
  // (a no-op for the atom), so the reconciler never fires — explicitly disarm any
  // armed error-path fallback here so a late refetch can't yank the user into a
  // just-failed chat after they chose a fresh one.
  const startNewChat = useCallback((): void => {
    cancelPendingAdoption();
    setActiveChatId(null);
    setHistoryOpen(false);
    setDraft("");
    // Default the picker back to "Universal assistant" for the fresh chat.
    setSelectedRoleId(null);
  }, [cancelPendingAdoption, setActiveChatId, setDraft, setSelectedRoleId]);

  const selectChat = useCallback(
    (chatId: string): void => {
      cancelPendingAdoption();
      setActiveChatId(chatId);
      setHistoryOpen(false);
      setDraft("");
      // Reset the card-picked role so a stale pick can't leak into the existing
      // chat's header/assistant-name (which prefers the chat's persisted role).
      setSelectedRoleId(null);
    },
    [cancelPendingAdoption, setActiveChatId, setDraft, setSelectedRoleId],
  );

  // The active chat object (for its title) and an export gate. The export is now
  // SERVER-sourced (the DB is the single source of truth — #183): the assistant
  // row is persisted upfront + per step, so even a brand-new chat whose first
  // turn is streaming/interrupted has a server row to render. Enable the button
  // whenever a persisted chat is active (`activeChatId` is set).
  const activeChat = useMemo(
    () => chats?.items?.find((c) => c.id === activeChatId) ?? null,
    [chats, activeChatId],
  );
  const canExport = !!activeChatId;

  // The role to display in the header and as the assistant's name. Prefer the
  // persisted role of an existing chat (chat-list JOIN); fall back to the role
  // picked via a card click for a brand-new or just-adopted chat. selectChat
  // resets selectedRoleId, so this fallback never leaks into an unrelated chat.
  const currentRole = useMemo<{
    name: string;
    emoji: string | null;
  } | null>(() => {
    if (activeChat?.roleName) {
      return { name: activeChat.roleName, emoji: activeChat.roleEmoji ?? null };
    }
    const picked = enabledRoles.find((r) => r.id === selectedRoleId);
    return picked ? { name: picked.name, emoji: picked.emoji } : null;
  }, [activeChat, enabledRoles, selectedRoleId]);

  // Fetch the server-rendered Markdown export and copy it to the clipboard. The
  // server is the single source of truth (#183): it renders the transcript from
  // the persisted rows — including an interrupted turn's in-progress row — so the
  // export is identical whether the chat is freshly streaming, just switched to,
  // or reloaded. The `lang` of the active i18n drives the few localized labels.
  const handleCopy = useCallback(async () => {
    if (!activeChatId) return;
    try {
      const markdown = await exportAiChat(activeChatId, i18n.language);
      clipboard.copy(markdown);
      notifications.show({ message: t("Copied") });
    } catch {
      notifications.show({ message: t("Failed to export chat"), color: "red" });
    }
  }, [activeChatId, clipboard, t, i18n.language]);

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
        if (!prev || (prev.width === width && prev.height === height))
          return prev;
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
          {/* While a turn streams, show the LIVE turn-token count (ticks ~8 Hz);
              once it finishes, fall back to the persisted context size. Require
              > 0 so the very first emit (an empty tail message, count 0) does not
              flash a "0" badge before any token streams in (#151 review). */}
          {liveTurnTokens !== null && liveTurnTokens > 0 ? (
            <Tooltip label={t("Tokens generated this turn")} withArrow>
              <span className={classes.badge}>
                {formatTokens(liveTurnTokens)}
              </span>
            </Tooltip>
          ) : contextTokens > 0 ? (
            <Tooltip label={t("Current context size")} withArrow>
              <span className={classes.badge}>
                {formatTokens(contextTokens)}
              </span>
            </Tooltip>
          ) : null}
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
              {clipboard.copied ? (
                <IconCheck size={14} />
              ) : (
                <IconCopy size={14} />
              )}
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
              onLiveTurnTokens={setLiveTurnTokens}
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
