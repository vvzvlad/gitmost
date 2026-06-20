import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Group, Loader, Select, Tooltip } from "@mantine/core";
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
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  activeAiChatIdAtom,
  aiChatWindowOpenAtom,
  aiChatDraftAtom,
  selectedAiRoleIdAtom,
} from "@/features/ai-chat/atoms/ai-chat-atom.ts";
import { usePageQuery } from "@/features/page/queries/page-query.ts";
import { extractPageSlugId } from "@/lib";
import {
  AI_CHATS_RQ_KEY,
  useAiChatMessagesQuery,
  useAiChatsQuery,
  useAiRolesQuery,
} from "@/features/ai-chat/queries/ai-chat-query.ts";
import ConversationList from "@/features/ai-chat/components/conversation-list.tsx";
import ChatThread from "@/features/ai-chat/components/chat-thread.tsx";
import { buildChatMarkdown } from "@/features/ai-chat/utils/chat-markdown.ts";
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
 * chat, new chat, adopt-new-chat, open-page context, token sum) and wraps the
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
  // Live window geometry (position + size); initialized lazily on first open so
  // it is anchored to the current viewport (top-right corner). Kept in state so
  // a user resize survives close/reopen and can be re-clamped to the viewport.
  const [geom, setGeom] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  // Track whether we are awaiting the id of a just-created (new) chat, so we
  // can adopt it once the chat list refreshes after the first turn finishes.
  const adoptNewChat = useRef(false);

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

  // The page the user is currently viewing, derived from the route (same
  // source the breadcrumb uses). On a non-page route `pageSlug` is undefined,
  // so the query is disabled and `openPage` is null. This is passed to the
  // chat thread as context so the agent knows what "this page"/"the current
  // page" refers to; the agent still reads/writes via its CASL-enforced page
  // tools using the id.
  const { pageSlug } = useParams();
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
  }, [setActiveChatId, setDraft, setSelectedRoleId]);

  const selectChat = useCallback(
    (chatId: string): void => {
      setActiveChatId(chatId);
      setHistoryOpen(false);
      setDraft("");
    },
    [setActiveChatId, setDraft],
  );

  // After a turn finishes, refresh the chat list. For a brand-new chat (no id
  // yet), the server has just created the row; adopt the newest chat id so the
  // thread switches from "new" to the persisted chat (and loads its history on
  // later opens).
  const onTurnFinished = useCallback(() => {
    if (activeChatId === null) adoptNewChat.current = true;
    queryClient.invalidateQueries({ queryKey: AI_CHATS_RQ_KEY });
  }, [activeChatId, queryClient]);

  // The active chat object (for its title) and an export gate: only enable the
  // export button when an existing chat with loaded persisted rows is active.
  const activeChat = useMemo(
    () => chats?.items?.find((c) => c.id === activeChatId) ?? null,
    [chats, activeChatId],
  );
  const canExport = !!activeChatId && !!messageRows && messageRows.length > 0;

  // Build a Markdown export from the already-loaded persisted rows (no network
  // call) and copy it to the clipboard. The "Copied" notification is the
  // feedback.
  const handleCopy = useCallback(() => {
    if (!activeChatId || !messageRows || messageRows.length === 0) return;
    const markdown = buildChatMarkdown({
      title: activeChat?.title ?? null,
      chatId: activeChatId,
      rows: messageRows,
      t,
    });
    clipboard.copy(markdown);
    notifications.show({ message: t("Copied") });
  }, [activeChatId, messageRows, activeChat, clipboard, t]);

  // When awaiting a new chat's id, adopt the most-recent chat (the list is
  // ordered newest-first) once it appears.
  useEffect(() => {
    if (!adoptNewChat.current) return;
    const newest = chats?.items?.[0];
    if (newest) {
      adoptNewChat.current = false;
      setActiveChatId(newest.id);
    }
  }, [chats, setActiveChatId]);

  // The thread is remounted when the active chat changes so initial messages
  // re-seed. For a new chat we key on "new"; adopting the id remounts the
  // thread with the persisted history loaded.
  const threadKey = activeChatId ?? "new";
  const waitingForHistory = activeChatId !== null && messagesLoading;

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
  }, [windowOpen, minimized]);

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

        {/* Role badge for the active chat (emoji + name). Shown only when the
            chat is bound to a role that still exists. */}
        {activeChat?.roleName && (
          <span className={classes.badge} title={t("Agent role")}>
            {activeChat.roleEmoji ? `${activeChat.roleEmoji} ` : ""}
            {activeChat.roleName}
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

        {/* Role picker — only for a NEW chat (before it is created). Once the
            chat exists, its role is fixed and shown as a header badge instead.
            Defaults to "Universal assistant" (no role). */}
        {activeChatId === null && (enabledRoles?.length ?? 0) > 0 && (
          <div style={{ padding: "4px 8px 0" }}>
            <Select
              size="xs"
              label={t("Agent role")}
              value={selectedRoleId ?? ""}
              onChange={(value) => setSelectedRoleId(value || null)}
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
              data={[
                { value: "", label: t("Universal assistant") },
                ...enabledRoles.map((r) => ({
                  value: r.id,
                  label: `${r.emoji ? `${r.emoji} ` : ""}${r.name}`,
                })),
              ]}
            />
          </div>
        )}

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
              onTurnFinished={onTurnFinished}
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
