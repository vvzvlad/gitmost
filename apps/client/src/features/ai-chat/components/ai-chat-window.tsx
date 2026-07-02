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
import { useAtom, useSetAtom } from "jotai";
import { useLocation, useMatch } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  activeAiChatIdAtom,
  aiChatWindowOpenAtom,
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
  const [minimized, setMinimized] = useState(false);
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
  const startNewChat = useCallback((): void => {
    cancelPendingAdoption();
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
  ]);

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
  // whenever a persisted chat is active (`activeChatId` is set). For a BRAND-NEW
  // chat that id is adopted EARLY — at the stream's `start` chunk via
  // onServerChatId (#174) — so the Copy button is available during the first
  // turn's stream, not only after it terminates.
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
            {currentRole.emoji ? `${currentRole.emoji} ` : ""}
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
              // Honoured only for a new chat; null = universal assistant.
              roleId={activeChatId === null ? selectedRoleId : null}
              // Role cards are the new-chat empty-state; offered only when this
              // is a brand-new chat. Clicking a card starts the chat with it.
              roles={activeChatId === null ? enabledRoles : undefined}
              onRolePicked={(role) => setSelectedRoleId(role.id)}
              assistantName={currentRole?.name}
              onTurnFinished={onTurnFinished}
              onServerChatId={onServerChatId}
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
