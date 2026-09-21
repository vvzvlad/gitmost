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
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMinus,
  IconPlus,
  IconX,
} from "@tabler/icons-react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useLocation, useMatch } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { LucideGlyph } from "@/components/ui/lucide/lucide-glyph.tsx";
import { parseIconRef } from "@/lib/icon-ref.ts";
import {
  activeAiChatIdAtom,
  aiChatWindowOpenAtom,
  aiChatWindowMinimizedAtom,
  aiChatWindowGeomAtom,
  aiChatWindowDockedAtom,
  aiChatDraftAtom,
  selectedAiRoleIdAtom,
} from "@/features/ai-chat/atoms/ai-chat-atom.ts";
import {
  APP_NAVBAR_ID,
  desktopSidebarAtom,
  mobileSidebarAtom,
} from "@/components/layouts/global/hooks/atoms/sidebar-atom.ts";
import { usePageMetaQuery } from "@/features/page/queries/page-query.ts";
import {
  pageEditorAtom,
  readOnlyEditorAtom,
} from "@/features/editor/atoms/editor-atoms.ts";
import {
  getEditorSelectionContext,
  type EditorSelectionContext,
} from "@/features/editor/utils/get-editor-selection.ts";
import { extractPageSlugId } from "@/lib";
import { resolveOpenPage } from "@/features/ai-chat/utils/resolve-open-page.ts";
import {
  AI_CHATS_RQ_KEY,
  AI_CHAT_MESSAGES_RQ_KEY,
  useAiChatMessagesQuery,
  useAiChatsQuery,
  useAiRolesQuery,
} from "@/features/ai-chat/queries/ai-chat-query.ts";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom";
import {
  markOperationStart,
  measureOperation,
} from "@/lib/telemetry/vitals";
import ConversationList from "@/features/ai-chat/components/conversation-list.tsx";
import ChatThread from "@/features/ai-chat/components/chat-thread.tsx";
import {
  bindPage,
  exportAiChat,
  stopRun,
} from "@/features/ai-chat/services/ai-chat-service.ts";
import { useAiChatDeltaPoll } from "@/features/ai-chat/hooks/use-delta-poll.ts";
import { useChatSession } from "@/features/ai-chat/hooks/use-chat-session.ts";
import {
  shouldCollapseOnOutsidePointer,
  isHeaderClick,
} from "@/features/ai-chat/utils/collapse-helpers.ts";
import { selectContextBadge } from "@/features/ai-chat/utils/context-badge.ts";
import {
  isPointWithinRect,
  isNavbarRectVisible,
  type NavbarRect,
} from "@/features/ai-chat/utils/dock-helpers.ts";
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

// #184 phase 1.5 / #430 / #488: the degraded-poll fallback. The window owns only
// a DUMB 2.5s timer, gated by an armed flag; the THREAD's run-lifecycle FSM owns
// arm/disarm AND the inactivity cap that turns a stuck run into a `stalled` banner
// (#488 commit 4a — the cap moved into the thread so polling->stalled is a single
// FSM transition; the window no longer silently stops polling at the cap).

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

// Clamp a geometry so the window stays within the current viewport — BOTH
// position and SIZE. Clamping size (mirroring computeInitialGeom's fit) is
// essential now that a persisted geometry is honoured on first open (getOnInit):
// the restore path is the main path, so a size saved on a large screen and
// restored on a small one would otherwise draw the composer and resize handle
// below a `position: fixed` viewport edge, with no way to shrink it back.
function clampGeom(g: {
  left: number;
  top: number;
  width: number;
  height: number;
}) {
  const width = Math.max(
    MIN_WIDTH,
    Math.min(g.width, window.innerWidth - 2 * EDGE_MARGIN),
  );
  const height = Math.max(
    MIN_HEIGHT,
    Math.min(g.height, window.innerHeight - 2 * EDGE_MARGIN),
  );
  const maxLeft = Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN);
  const maxTop = Math.max(
    EDGE_MARGIN,
    window.innerHeight - height - EDGE_MARGIN,
  );
  return {
    left: Math.min(Math.max(EDGE_MARGIN, g.left), maxLeft),
    top: Math.min(Math.max(EDGE_MARGIN, g.top), maxTop),
    width,
    height,
  };
}

// Live bounding rect of the app-shell navbar (the page-tree sidebar), by its
// stable id. Returns null when the navbar is absent OR collapsed: Mantine
// collapses the navbar by translating it off-screen (its right edge lands at or
// left of the viewport), so a zero-size or off-screen rect is treated as "no
// navbar" — the docked window then falls back to floating instead of pinning to
// an off-screen box. Reads the DOM, so call it inside effects / handlers only.
function getNavbarRect(): NavbarRect | null {
  const el = document.getElementById(APP_NAVBAR_ID);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Off-screen/collapsed navbar (visibility predicate extracted + unit-tested).
  if (!isNavbarRectVisible(r)) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

// Whether a viewport point falls within the (visible) navbar bounds. Used to
// decide dock-on-drop and undock-on-drag-out. The point-in-rect math is the pure
// isPointWithinRect helper (unit-tested); this only supplies the live rect.
function isPointerOverNavbar(x: number, y: number): boolean {
  return isPointWithinRect(x, y, getNavbarRect());
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
  // Persisted (via the shared chrome key) so a restored-collapsed window stays
  // collapsed across reload. Reset to expanded on CLOSE, not on open (see the
  // layout effect below), so restoring a collapsed window survives.
  const [minimized, setMinimized] = useAtom(aiChatWindowMinimizedAtom);
  // Mirror of `minimized` for handlers wrapped in useCallback([]) (startDrag),
  // which would otherwise close over a stale value. Kept in sync below.
  const minimizedRef = useRef(minimized);
  minimizedRef.current = minimized;

  // Docked-into-sidebar mode (#276). Persisted so it survives reload + reopen.
  // When docked the SAME window instance pins itself to the navbar rect below.
  const [docked, setDocked] = useAtom(aiChatWindowDockedAtom);
  // Mirror for the useCallback([]) drag handlers (same reason as minimizedRef).
  const dockedRef = useRef(docked);
  dockedRef.current = docked;
  // Live navbar rect the docked window is pinned to; synced before paint by the
  // layout effect below. null = navbar absent/collapsed -> floating fallback.
  const [dockRect, setDockRect] = useState<NavbarRect | null>(null);
  // While dragging a FLOATING window over the navbar: show the drop-zone hint.
  const [dockHint, setDockHint] = useState(false);
  // Live window position during a drag. Normally the drag is fully imperative
  // (el.style updated per mousemove, no re-render — matching the pre-#276
  // behavior), so this stays null. It is set ONLY at a navbar-boundary crossing:
  // that crossing already forces a re-render (dockHint flips), which would
  // otherwise re-apply the committed geom and snap the box back for a frame — so
  // we hand the render the live position at that instant instead. Cleared on drop.
  const [dragPos, setDragPos] = useState<{ left: number; top: number } | null>(
    null,
  );

  // Subscribed (read-only) so this component re-renders — and the dockRect-sync
  // effect below re-runs — when the sidebar is collapsed/expanded via the header
  // toggle. Mantine collapses the navbar with a transform (width/border-box
  // unchanged), so the navbar's ResizeObserver never fires; these deps + the
  // navbar `transitionend` listener are what re-measure the rect on toggle.
  const [desktopSidebarOpen] = useAtom(desktopSidebarAtom);
  const [mobileSidebarOpen] = useAtom(mobileSidebarAtom);

  // Dock mode is only EFFECTIVE when a navbar rect is available. When docked but
  // the navbar is absent/collapsed (dockRect === null) the window falls back to
  // the floating look, so effects gated on "is docked" must use this — not the
  // raw `docked` flag — or a fallback-floating window would behave half-docked.
  const useDock = docked && dockRect !== null;

  const location = useLocation();

  const winRef = useRef<HTMLDivElement>(null);
  // Live window geometry (position + size); persisted to localStorage so a
  // drag/resize survives a full page reload (and close/reopen). `null` means
  // "never placed yet" — the layout effect below then computes an initial
  // top-right placement anchored to the current viewport, and on restore it is
  // re-clamped to the viewport (so a placement saved on a larger screen is not
  // left partly off-screen).
  const [geom, setGeom] = useAtom(aiChatWindowGeomAtom);

  // Gated on windowOpen: the chat list is only needed once the window is open,
  // so a closed window issues no chat-list request/refetch on navigation.
  const { data: chats } = useAiChatsQuery(windowOpen);
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

  // #184 phase 1.5 / #488: degraded-poll fallback. ChatThread's FSM arms this via
  // onResumeFallback(true) when it enters a poll-bearing recovery (attach 204 /
  // starved finish / stop) and disarms it on settle / local stream / stalled. The
  // window owns ONLY the dumb 2.5s timer; the THREAD owns arm/disarm AND the
  // inactivity cap (a stuck run -> the thread's `stalled` banner disarms this).
  const [degradedPoll, setDegradedPoll] = useState(false);
  const onResumeFallback = useCallback((active: boolean): void => {
    setDegradedPoll(active);
  }, []);
  // Reset the degraded poll whenever the open chat changes: it is scoped to the
  // resume attempt of the previously-open chat (invariant 8).
  useEffect(() => {
    setDegradedPoll(false);
  }, [activeChatId]);

  const { data: messageRows, isLoading: messagesLoading } =
    useAiChatMessagesQuery(
      activeChatId ?? undefined,
      // #491: the full infinite-query no longer POLLS. It seeds the thread ONCE; the
      // degraded fallback now runs a DELTA poller (below) that augments THIS cache
      // idempotently, instead of refetching every page (with full parts) every 2.5s.
      false,
      // #344: gate on windowOpen too — no message history is fetched while the window
      // is closed; it loads when the window opens with an active chat.
      windowOpen,
    );

  // #491/#555 degraded DELTA poll. The transport (cursor lifecycle, merge into the
  // messages cache, the 2.5s timer) lives in `useAiChatDeltaPoll` — extracted so it
  // is unit-testable in isolation (W1). The thread's FSM owns arm/disarm (degradedPoll
  // via onResumeFallback) and CONSUMES the run fact the hook surfaces: `polledRunFact`
  // is threaded into <ChatThread>, where a fresh NEGATIVE fact quenches a stale
  // `reconnecting`/`polling` immediately (#555 S3 / I3). See run-fsm.spec.md §3.4.
  const polledRunFact = useAiChatDeltaPoll({
    chatId: activeChatId,
    armed: degradedPoll,
    enabled: windowOpen,
  });

  // #184 reconnect-and-live-follow. Whether detached agent runs are enabled for
  // this workspace. When the feature is off no runs are ever created, so the
  // resume attempt would only ever 204; gating ChatThread's resume on it avoids a
  // pointless attach round-trip.
  const workspace = useAtomValue(workspaceAtom);
  const autonomousRunsEnabled =
    workspace?.settings?.ai?.autonomousRuns === true;

  // Authoritative stop of the open chat's detached run (the Stop button in
  // autonomous mode). Request the server stop — the ONLY thing that ends a
  // detached run; a mere local SSE abort is a client disconnect the server
  // ignores. On failure surface the error.
  const handleServerStop = useCallback(
    (chatId: string): void => {
      void stopRun(chatId).catch(() => {
        notifications.show({
          message: t("Failed to stop the run"),
          color: "red",
        });
      });
    },
    [t],
  );

  // The page the user is currently viewing. AiChatWindow lives in a pathless
  // parent layout route, so useParams() can't see :pageSlug. Match the full
  // pathname against the authenticated page route instead so "the current page"
  // resolves regardless of where this component is mounted. On a non-page route
  // the match is null, so `pageSlug` is undefined and the query is disabled. This
  // is passed to the chat thread as context so the agent knows what "this
  // page"/"the current page" refers to; the agent still reads/writes via its
  // CASL-enforced page tools using the id.
  const pageRouteMatch = useMatch("/s/:spaceSlug/p/:pageSlug");
  const pageSlug = pageRouteMatch?.params?.pageSlug;
  const routePageId = extractPageSlugId(pageSlug);
  const { data: openPageData } = usePageMetaQuery({ pageId: routePageId });
  // #665 live-bug fix: usePageMetaQuery keeps the LAST page's metadata as a
  // keepPreviousData placeholder when disabled (off a page), so `openPageData` does
  // NOT go null on /home. resolveOpenPage discards that stale placeholder — the
  // open page must be the page the ROUTE says we are on, or nothing at all — so the
  // server binds/reports the right page (or none).
  const openPage = resolveOpenPage(openPageData, routePageId);

  // Live editor handles for the selection snapshot (#388). Both are published by
  // the page editor; the read-only editor is used in read mode. Reading the
  // selection off `editor.state` stays valid after the editor blurs (ProseMirror
  // keeps state.selection), mirroring the comment button (comment-dialog.tsx).
  const pageEditor = useAtomValue(pageEditorAtom);
  const readOnlyEditor = useAtomValue(readOnlyEditorAtom);

  // Snapshot the user's current editor selection at send time. Edit-mode editor
  // wins; the read-only editor is the fallback (read mode). Null when neither
  // holds a non-empty selection. Passed to <ChatThread>, which reads it live
  // from a ref inside prepareSendMessagesRequest — so each turn ships a fresh
  // snapshot and multi-turn works without recreating the transport.
  const getEditorSelection = useCallback((): EditorSelectionContext | null => {
    for (const editor of [pageEditor, readOnlyEditor]) {
      if (!editor || editor.isDestroyed) continue;
      const sel = getEditorSelectionContext(editor.state);
      if (sel) return sel;
    }
    return null;
  }, [pageEditor, readOnlyEditor]);

  // The AI-chat thread-identity lifecycle (mount key, both new-chat id adoption
  // paths, the history-loaded latch, the render-phase reconciler) lives in this
  // hook. See adopt-chat-id.ts for the canonical #137 two-tab race explanation.
  // The invalidate closures are passed inline: `onTurnFinished` is read live by
  // useChat's onFinish (never in an effect dep array), so their identity does not
  // matter — no memoization ceremony needed.
  const {
    threadKey,
    waitingForHistory,
    startFreshThread,
    onTurnFinished,
    onServerChatId,
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
  // #665: the last in-flight "New chat" unbind (DELETE /bind-page). ChatThread's
  // first send of a fresh thread waits on this so an immediate role-card click
  // can't race its DELETE past the server's birth UPSERT. It MUST live here (not
  // in ChatThread): startNewChat remounts ChatThread, so a ref inside it would be
  // lost at the exact moment the gate is needed. Read-and-cleared by the thread.
  const pendingUnbindRef = useRef<Promise<unknown> | null>(null);

  const startNewChat = useCallback((): void => {
    cancelPendingAdoption();
    // #665: "New chat" CLEARS the page binding (empty chat = nothing bound). Write
    // for the LIVE page in the URL (routePageId), not openPage.id (a possibly-stale
    // placeholder — see the openPage live-bug fix). Off a document => nothing to
    // unbind. Fire-and-forget (never blocks the UI), and stash the promise so the
    // fresh thread's first send sequences after it (the New-chat->instant-send
    // race). `.catch` is mandatory: the only trace + no unhandled rejection.
    if (routePageId) {
      pendingUnbindRef.current = bindPage(routePageId, null).catch((err) => {
        console.error(err);
      });
    }
    // Force a fresh, empty thread UNCONDITIONALLY (#161). Pressing "New chat"
    // while a brand-new chat's first turn is still streaming leaves activeChatId
    // null (the real id is adopted only at turn end), so setActiveChatId(null)
    // alone is a no-op and the reconciler never remounts — the chat/stream/history
    // would persist and only the role badge would drop. This always remounts the
    // thread into a clean new chat.
    startFreshThread();
    setActiveChatId(null);
    setHistoryOpen(false);
    setDraft("");
    // Default the picker back to "Universal assistant" for the fresh chat.
    setSelectedRoleId(null);
  }, [
    cancelPendingAdoption,
    startFreshThread,
    setActiveChatId,
    setDraft,
    setSelectedRoleId,
    routePageId,
  ]);

  const selectChat = useCallback(
    (chatId: string): void => {
      cancelPendingAdoption();
      // #665: choosing a chat from history is a CONSCIOUS open, so it RE-BINDS the
      // current page to it. Write for the LIVE page in the URL; off a document =>
      // no binding. Fire-and-forget so the chat opens instantly (the round-trip
      // never gates the switch); `.catch` is the only error trace.
      if (routePageId) {
        void bindPage(routePageId, chatId).catch((err) => {
          console.error(err);
        });
      }
      setActiveChatId(chatId);
      setHistoryOpen(false);
      setDraft("");
      // Reset the card-picked role so a stale pick can't leak into the existing
      // chat's header/assistant-name (which prefers the chat's persisted role).
      setSelectedRoleId(null);
    },
    [
      cancelPendingAdoption,
      setActiveChatId,
      setDraft,
      setSelectedRoleId,
      routePageId,
    ],
  );

  // The active chat object (for its title) and an export gate. The export is now
  // SERVER-sourced (the DB is the single source of truth — #183): the assistant
  // row is persisted upfront + per step, so even a brand-new chat whose first
  // turn is streaming/interrupted has a server row to render. Enable the button
  // whenever a persisted chat is active (`activeChatId` is set). For a BRAND-NEW
  // chat that id is adopted EARLY — at the stream's `start` chunk via
  // onServerChatId (#174) — so the Copy button is available during the first
  // turn's stream, not only after it terminates.
  const activeChat = useMemo(
    () => chats?.items?.find((c) => c.id === activeChatId) ?? null,
    [chats, activeChatId],
  );
  const canExport = !!activeChatId;

  // #683 `ai_chat_open` — mark when the chat window opens (the user toggled it
  // open; this component is always mounted and only null-renders while closed, so
  // the windowOpen→true edge is the open action). The matching measure fires at
  // the first render of the message list — i.e. when the history loader clears
  // and <ChatThread> mounts (waitingForHistory → false). measureOperation
  // consumes the mark, so it reports once per open; a window closed before the
  // thread rendered leaves the mark to expire.
  useEffect(() => {
    if (windowOpen) markOperationStart("ai_chat_open");
  }, [windowOpen]);

  useEffect(() => {
    if (windowOpen && !waitingForHistory) measureOperation("ai_chat_open");
  }, [windowOpen, waitingForHistory]);

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
  //
  // The denominator `maxContextTokens` (the model's configured max window) is
  // derived in the SAME backward scan: it is stamped alongside `contextTokens`
  // on a completed turn, but the numerator and denominator are taken from the
  // most recent row carrying EACH value independently — they may land on
  // different rows (e.g. a fresh error row can carry contextTokens but not
  // maxContextTokens), so we keep scanning for whichever is still unset. 0 when
  // no row has it (older rows, or no admin-configured limit) — the badge then
  // shows just the current size with no denominator.
  const { contextTokens, maxContextTokens } = useMemo(
    () => selectContextBadge(activeChatId ? messageRows : undefined),
    [activeChatId, messageRows],
  );

  // Two operators with OPPOSITE lifecycles, so they cannot share a guard:
  //
  // - On CLOSE: reset the collapsed state. Doing it here (not on open) is what
  //   lets a RESTORED-collapsed window stay collapsed across reload — the design
  //   goal — while still expanding a window that was collapsed→closed→reopened
  //   within the same session (its close already reset the flag). It also makes
  //   `{open:false, minimized:true}` unrepresentable. A guard on "previous
  //   windowOpen" can't work: the latch mounts the window only AFTER windowOpen
  //   is already true, so its first render can't tell restore from a fresh click.
  //
  // - On OPEN: settle the geometry before paint (useLayoutEffect → no first-frame
  //   jump). With getOnInit the restored geom is already in the atom on this
  //   first render, so `prev` is non-null and we take the clampGeom branch — this
  //   is the fix for the old clobber where computeInitialGeom overwrote the saved
  //   geometry. First placement (prev null) still computes the top-right default.
  useLayoutEffect(() => {
    if (!windowOpen) {
      setMinimized(false);
      return;
    }
    setGeom((prev) => (prev ? clampGeom(prev) : computeInitialGeom()));
  }, [windowOpen]);

  // Docking clears the collapsed flag. Done as an effect on `docked` (not in the
  // three dock-write call sites) and keyed on the RAW `docked` — not `useDock`:
  // a docked window whose navbar is collapsed has `useDock === false`, and gating
  // on useDock would skip exactly that fallback-floating case, leaving
  // `docked:true + minimized:true` durable (the collapsed view is hidden while
  // docked and the Minimize button is hidden, so the flag would be stuck and
  // invisible, then the next Undock would collapse the window to a bare header).
  useEffect(() => {
    if (docked) setMinimized(false);
  }, [docked]);

  // While docked, keep the window pinned to the navbar's LIVE rect. useLayoutEffect
  // (not useEffect) so dockRect is measured/committed before the browser paints,
  // avoiding a first-frame jump. Re-measures on: navbar size changes (manual
  // sidebar resize -> ResizeObserver), viewport resize (window `resize`), and
  // route changes that swap the navbar width (space <-> shared/global sidebar are
  // 300px vs sidebarWidth -> re-run on location.pathname). If the navbar is
  // absent/collapsed, getNavbarRect() returns null and the render falls back to
  // the floating look (the window does NOT vanish).
  useLayoutEffect(() => {
    if (!windowOpen || !docked) return;
    const sync = () => setDockRect(getNavbarRect());
    sync();
    const navbar = document.getElementById(APP_NAVBAR_ID);
    let ro: ResizeObserver | null = null;
    if (navbar) {
      ro = new ResizeObserver(sync);
      ro.observe(navbar);
      // Collapsing/expanding the sidebar translates the navbar off-screen WITHOUT
      // changing its width/border-box, so the ResizeObserver never fires and the
      // effect's initial sync() may measure mid-transition (stale). Re-measure at
      // transitionend so getNavbarRect() sees the final position: null once the
      // navbar is translated off (right <= 0) -> fall back to floating; the real
      // rect once it slides back -> re-dock. The sidebar-state deps below force
      // this effect (and the immediate sync) to re-run on each toggle, covering
      // the reduced-motion case where no transition -> no transitionend.
      navbar.addEventListener("transitionend", sync);
    }
    window.addEventListener("resize", sync);
    return () => {
      ro?.disconnect();
      navbar?.removeEventListener("transitionend", sync);
      window.removeEventListener("resize", sync);
    };
  }, [
    windowOpen,
    docked,
    location.pathname,
    desktopSidebarOpen,
    mobileSidebarOpen,
  ]);

  // Auto-collapse the window into its header as soon as the user interacts with
  // anything outside it (clicks the page/editor). Armed ONLY while the window is
  // open and expanded, so it never fires repeatedly and never collapses on the
  // open→reset transition. Capture phase so a page handler's stopPropagation in
  // the bubble phase can't hide the event from us; the in-window/portal guards
  // (shouldCollapseOnOutsidePointer) prevent false collapses from clicks inside
  // the window or inside Mantine portals (kebab menu, delete-confirm modal).
  useEffect(() => {
    // Disabled while EFFECTIVELY docked: a docked window intentionally overlays
    // the page tree, so a click on the surrounding page must NOT auto-collapse
    // it. Gated on useDock (not raw `docked`) so a fallback-floating window
    // (docked but navbar absent/collapsed) still auto-collapses like a normal
    // floating window.
    if (!windowOpen || minimized || useDock) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (shouldCollapseOnOutsidePointer(e.target, winRef.current)) {
        setMinimized(true);
      }
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [windowOpen, minimized, useDock]);

  // Persist the user's resize into state so it survives close/reopen. Skipped
  // while minimized so the collapsed (auto) height is never captured. The
  // equality guard avoids an update loop.
  useEffect(() => {
    // Disabled while EFFECTIVELY docked: in dock mode the size is driven by the
    // navbar rect, not a user resize, so we must not capture the navbar-sized box
    // into the persisted floating geom (it would clobber the remembered floating
    // size). Gated on useDock so a fallback-floating window (docked but navbar
    // absent) still persists user resizes like a normal floating window.
    if (!windowOpen || minimized || useDock) return;
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
  }, [windowOpen, minimized, useDock, geom !== null]);

  const startDrag = useCallback((e: React.MouseEvent): void => {
    // Ignore drags that originate on a button (dock/minimize/close/new chat).
    if ((e.target as HTMLElement).closest("button")) return;
    const el = winRef.current;
    if (!el) return;

    const sx = e.clientX;
    const sy = e.clientY;
    // Starting position: the element's current inline left/top, whether it was
    // placed by the floating geom or pinned to the navbar rect (both render as
    // "<n>px"). getBoundingClientRect would work too, but the inline values keep
    // the drag math identical to the pre-#276 floating behavior.
    const ol = parseFloat(el.style.left) || 0;
    const ot = parseFloat(el.style.top) || 0;
    // Freeze the box size for the drag: a docked window keeps its navbar size
    // while being pulled out, a floating window keeps its own size.
    const dragW = el.offsetWidth;
    const dragH = el.offsetHeight;

    // Latch for the drop-zone hint so setState fires only when the pointer
    // actually crosses the navbar boundary, not on every mousemove.
    let overNavbar = false;

    const move = (ev: MouseEvent): void => {
      let nl = ol + (ev.clientX - sx);
      let nt = ot + (ev.clientY - sy);
      // Clamp to the viewport (not the parent — the window is mounted globally
      // with position: fixed) with an 8px margin.
      nl = Math.max(
        EDGE_MARGIN,
        Math.min(nl, window.innerWidth - dragW - EDGE_MARGIN),
      );
      nt = Math.max(
        EDGE_MARGIN,
        Math.min(nt, window.innerHeight - dragH - EDGE_MARGIN),
      );
      el.style.left = `${nl}px`;
      el.style.top = `${nt}px`;
      // Drop-zone highlight: only meaningful when dragging a FLOATING window in
      // to dock it (a docked window is already over the navbar).
      if (!dockedRef.current) {
        const nowOver = isPointerOverNavbar(ev.clientX, ev.clientY);
        if (nowOver !== overNavbar) {
          overNavbar = nowOver;
          // This re-render would re-apply the committed geom; hand it the live
          // position so the box does not snap back for a frame.
          setDragPos({ left: nl, top: nt });
          setDockHint(nowOver);
        }
      }
    };

    const up = (ev: MouseEvent): void => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.userSelect = "";
      setDragPos(null);
      setDockHint(false);
      const overNavbarNow = isPointerOverNavbar(ev.clientX, ev.clientY);

      if (dockedRef.current) {
        // Docked window: releasing OUTSIDE the navbar pops it out as a floating
        // window at the drop point (clamped to the viewport). Released over the
        // navbar -> stays docked (a header click is a no-op here). The response
        // stream is untouched — only the mode flag / geom change.
        if (!overNavbarNow) {
          const el2 = winRef.current;
          const dropLeft = el2 ? parseFloat(el2.style.left) || 0 : 0;
          const dropTop = el2 ? parseFloat(el2.style.top) || 0 : 0;
          setGeom((prev) =>
            clampGeom({
              ...(prev ?? computeInitialGeom()),
              left: dropLeft,
              top: dropTop,
            }),
          );
          setDocked(false);
        }
        return;
      }

      // Floating window.
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
      // Released over the navbar -> dock. The layout effect then pins the window
      // to the navbar rect; the last floating geom is left untouched so a later
      // undock/close restores the remembered floating placement.
      if (overNavbarNow) {
        setDocked(true);
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

  // Dock/undock via the header button. Docking pins the window to the navbar;
  // undocking restores the floating window at its last remembered geom. On
  // undock we re-clamp that geom to the current viewport (matching drag-undock's
  // clampGeom) so a viewport shrink while docked can't leave the popped-out
  // window partly off-screen. The chat thread stays mounted across the toggle,
  // so a live stream is intact. dockedRef gives the live value inside this
  // useCallback([]) handler.
  const toggleDock = useCallback((): void => {
    if (dockedRef.current) {
      setGeom((prev) => (prev ? clampGeom(prev) : prev));
    }
    setDocked((d) => !d);
  }, [setDocked, setGeom]);

  // Just toggle the flag. The `.minimized` CSS handles the collapsed height and
  // disables resize, and `.minimized .content` hides the body while keeping
  // ChatThread mounted (so an in-flight stream is not aborted).
  const toggleMinimize = useCallback((): void => {
    setMinimized((m) => !m);
  }, []);

  if (!windowOpen || !geom) return null;

  // `useDock` (computed above) is the EFFECTIVE dock state: docked AND a navbar
  // rect is available. If the navbar is absent/collapsed we keep the persisted
  // `docked` flag but render the floating look so the window never vanishes (it
  // re-docks once the navbar reappears — see the layout effect above). Minimize
  // is suppressed while actually docked.
  const showMinimized = minimized && !useDock;

  // Position/size of the window this frame. `dragPos` (set only at a mid-drag
  // navbar-boundary crossing) overrides the committed position so the box does
  // not snap back for a frame when that crossing forces a re-render.
  const boxStyle = dockRect && useDock
    ? {
        left: dockRect.left,
        top: dockRect.top,
        width: dockRect.width,
        height: dockRect.height,
      }
    : {
        left: geom.left,
        top: geom.top,
        width: geom.width,
        // Height omitted when minimized so the `.minimized` CSS auto-height wins.
        height: showMinimized ? undefined : geom.height,
      };
  const style = dragPos
    ? { ...boxStyle, left: dragPos.left, top: dragPos.top }
    : boxStyle;

  // Drop-zone highlight over the navbar bounds while dragging a floating window
  // onto the sidebar. Rendered as a viewport-fixed sibling overlay (not inside
  // the moving window), so its position is independent of the drag.
  const hintRect = dockHint ? getNavbarRect() : null;

  return (
    <>
    <div
      ref={winRef}
      className={`${classes.window}${showMinimized ? ` ${classes.minimized}` : ""}${useDock ? ` ${classes.docked}` : ""}`}
      style={style}
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
          role={showMinimized ? "button" : undefined}
          tabIndex={showMinimized ? 0 : undefined}
          aria-label={showMinimized ? t("Expand") : undefined}
          onKeyDown={
            showMinimized
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
            {parseIconRef(currentRole.emoji)?.name && (
              <LucideGlyph
                name={parseIconRef(currentRole.emoji)?.name}
                size={14}
              />
            )}
            {currentRole.name}
          </span>
        )}

        <div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
          {/* Always show the persisted "current / max" context. The denominator
              (the admin-configured model limit) is appended only when known;
              not clamped when current > max (shown as-is, e.g. "210k / 200k").
              Hidden entirely until a turn has recorded a context figure. */}
          {contextTokens > 0 ? (
            <Tooltip label={t("Context size / model limit")} withArrow>
              <span className={classes.badge}>
                {formatTokens(contextTokens)}
                {maxContextTokens > 0
                  ? ` / ${formatTokens(maxContextTokens)}`
                  : ""}
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
          {/* Dock/undock toggle. Effectively docked -> "Undock" (expand icon) pops
              the window back out to floating; floating -> "Dock to sidebar"
              (collapse icon) pins it into the navbar. The LABEL/icon reflect the
              EFFECTIVE state (useDock), consistent with the Minimize gate: when
              docked but the navbar is absent/collapsed the window renders floating,
              so an "Undock" label there would misdescribe a floating window. The
              action still toggles the raw `docked` atom. */}
          <button
            type="button"
            className={classes.headerBtn}
            title={useDock ? t("Undock") : t("Dock to sidebar")}
            aria-label={useDock ? t("Undock") : t("Dock to sidebar")}
            onClick={toggleDock}
          >
            {useDock ? (
              <IconLayoutSidebarLeftExpand size={14} />
            ) : (
              <IconLayoutSidebarLeftCollapse size={14} />
            )}
          </button>
          {/* Minimize (collapse to header) makes no sense while docked — the
              window fills the navbar — so it is hidden in dock mode. */}
          {!useDock && (
            <button
              type="button"
              className={classes.headerBtn}
              title={t("Minimize")}
              aria-label={t("Minimize")}
              onClick={toggleMinimize}
            >
              <IconMinus size={14} />
            </button>
          )}
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
              threadKey={threadKey}
              chatId={activeChatId}
              initialRows={activeChatId ? messageRows : []}
              openPage={openPage}
              // #388: live snapshotter for the user's editor selection, read at
              // send time and nested inside openPage on the wire.
              getEditorSelection={getEditorSelection}
              // Honoured only for a new chat; null = universal assistant.
              roleId={activeChatId === null ? selectedRoleId : null}
              // Role cards are the new-chat empty-state; offered only when this
              // is a brand-new chat. Clicking a card starts the chat with it.
              roles={activeChatId === null ? enabledRoles : undefined}
              onRolePicked={(role) => setSelectedRoleId(role.id)}
              assistantName={currentRole?.name}
              onTurnFinished={onTurnFinished}
              onServerChatId={onServerChatId}
              // #184 phase 1.5: arm/disarm the degraded-poll fallback when a
              // resume attempt could not attach to the live run; the thread
              // disarms it on settle / local stream.
              onResumeFallback={onResumeFallback}
              // #555 S3: the degraded delta poll's authoritative run fact. The FSM
              // consumes a fresh NEGATIVE fact to quench a stale reconnecting/polling
              // immediately (I3), rather than waiting for the terminal row.
              polledRunFact={polledRunFact}
              // #184: in autonomous mode the Stop button must hit the authoritative
              // server stop (a local SSE abort is a client disconnect the server
              // ignores).
              autonomousRunsEnabled={autonomousRunsEnabled}
              onServerStop={handleServerStop}
              // #665: the last "New chat" unbind promise; the thread's first send
              // of a fresh thread waits on it so an instant role-card click can't
              // race its DELETE past the server's birth UPSERT.
              pendingUnbindRef={pendingUnbindRef}
            />
          )}
        </div>
      </div>

      {/* resize affordance icon (drawn manually; native resizer is hidden).
          Hidden while docked — the docked size follows the navbar, not a manual
          resize. */}
      {!showMinimized && !useDock && (
        <span className={classes.resizeHandle}>
          <IconArrowsDiagonal size={12} />
        </span>
      )}
    </div>
      {/* Drop-zone highlight over the navbar while dragging a floating window in
          to dock it. Sibling of the window (position: fixed) so it tracks the
          navbar bounds, not the moving window. */}
      {hintRect && (
        <div
          className={classes.dockHighlight}
          style={{
            left: hintRect.left,
            top: hintRect.top,
            width: hintRect.width,
            height: hintRect.height,
          }}
        />
      )}
    </>
  );
}
