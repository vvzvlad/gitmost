import "@/features/editor/styles/index.css";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { WebSocketStatus } from "@hocuspocus/provider";
import {
  Editor,
  EditorContent,
  EditorProvider,
  useEditor,
  useEditorState,
} from "@tiptap/react";
import {
  collabExtensions,
  mainExtensions,
} from "@/features/editor/extensions/extensions";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import useCollaborationUrl from "@/features/editor/hooks/use-collaboration-url";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import {
  bodyLocalOnlyAtom,
  bodyWriteBlockedAtom,
  collabProviderAtom,
  currentPageEditModeAtom,
  dictationAvailabilityAtom,
  pageEditorAtom,
  yjsConnectionStatusAtom,
} from "@/features/editor/atoms/editor-atoms";
import { Skeleton } from "@mantine/core";
import { asideStateAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom";
import {
  activeCommentIdAtom,
  showCommentPopupAtom,
  showReadOnlyCommentPopupAtom,
} from "@/features/comment/atoms/comment-atom";
import CommentDialog from "@/features/comment/components/comment-dialog";
import CommentHoverPreview from "@/features/comment/components/comment-hover-preview";
import { EditorBubbleMenu } from "@/features/editor/components/bubble-menu/bubble-menu";
import { ReadonlyBubbleMenu } from "@/features/editor/components/bubble-menu/readonly-bubble-menu";
import TableMenu from "@/features/editor/components/table/table-menu.tsx";
import { TableHandlesLayer } from "@/features/editor/components/table/handle/table-handles-layer";
import ImageMenu from "@/features/editor/components/image/image-menu.tsx";
import CalloutMenu from "@/features/editor/components/callout/callout-menu.tsx";
import VideoMenu from "@/features/editor/components/video/video-menu.tsx";
import AudioMenu from "@/features/editor/components/audio/audio-menu.tsx";
import PdfMenu from "@/features/editor/components/pdf/pdf-menu.tsx";
import SubpagesMenu from "@/features/editor/components/subpages/subpages-menu.tsx";
import {
  handleFileDrop,
  handlePaste,
} from "@/features/editor/components/common/editor-paste-handler.tsx";
import ExcalidrawMenu from "./components/excalidraw/excalidraw-menu-lazy";
import DrawioMenu from "./components/drawio/drawio-menu-lazy";
import { useCollabToken } from "@/features/auth/queries/auth-query.tsx";
import SearchAndReplaceDialog from "@/features/editor/components/search-and-replace/search-and-replace-dialog.tsx";
import { useDocumentVisibility } from "@mantine/hooks";
import { useIdle } from "@/hooks/use-idle.ts";
import { useParams } from "react-router-dom";
import { extractPageSlugId, platformModifierKey } from "@/lib";
import {
  GitmostBridge,
  GitmostInsertRecordingPayload,
  GitmostInsertRecordingResult,
  gitmostInsertRecordingIntoEditor,
} from "@/features/editor/gitmost/gitmost-recording.ts";
import { FIVE_MINUTES } from "@/lib/constants.ts";
import { PageEditMode } from "@/features/user/types/user.types.ts";
import { openSearchSpotlight } from "@/features/search/constants.ts";
import { useEditorScroll } from "./hooks/use-editor-scroll";
import { usePageContentCache } from "./hooks/use-page-content-cache";
import { useScrollRestoreOnSwap } from "./hooks/use-scroll-position";
import { useSwapHeightReservation } from "./hooks/use-swap-height-reservation";
import { decideSocketIdleAction } from "./hooks/socket-idle-reconnect";
import { EditorLinkMenu } from "@/features/editor/components/link/link-menu";
import ColumnsMenu from "@/features/editor/components/columns/columns-menu.tsx";
import { TransclusionLookupProvider } from "@/features/editor/components/transclusion/transclusion-lookup-context";
import { PageEmbedLookupProvider } from "@/features/editor/components/page-embed/page-embed-lookup-context";
import { PageEmbedAncestryProvider } from "@/features/editor/components/page-embed/page-embed-ancestry-context";
import PageEmbedPicker from "@/features/editor/components/page-embed/page-embed-picker";
import { useTranslation } from "react-i18next";
import {
  computeBodyIndicator,
  computeDictationAvailability,
  isBodyEditable,
  isCollabSynced,
  shouldSwapToLive,
} from "@/features/editor/editor-sync-state";
import { createBodyWriteGuard } from "@/features/editor/local-first-body";
import { pageYdocDbName } from "@/features/editor/page-ydoc-eviction";
import { getReconciledAt } from "@/features/editor/page-ydoc-reconciled";
import {
  acquirePageSession,
  type PageSession,
  peekWarmSession,
  releasePageSession,
} from "@/features/editor/page-session-cache";
import { scopeKeyAtom } from "@/features/page/tree/atoms/open-tree-nodes-atom";
import {
  armBodyPaint,
  disarmBodyPaint,
  isVitalsActive,
  markOperationStart,
  notePageBodyPaint,
  reportEditorTx,
} from "@/lib/telemetry/vitals";

// #709 — the ONE rule deriving the body's sync flags from a collab session,
// applied in three places: the initial state of a mount (from the peeked
// session), the reset block on a page / session change, and the session
// listener. There is no warm / default split in the component: a warm session
// yields synced, confirmed and live on its own. `isRemoteConfirmed` stays
// sticky (`wasRemoteConfirmed`), as before.
function flagsFromSession(s: PageSession, wasRemoteConfirmed: boolean) {
  const isLocalSynced = s.localSynced;
  const ydocNonEmpty = s.ydocNonEmpty;
  const isRemoteSynced = s.remote.isSynced;
  const yjsConnectionStatus = s.socket.status;
  return {
    isLocalSynced,
    ydocNonEmpty,
    isRemoteSynced,
    yjsConnectionStatus,
    isRemoteConfirmed: wasRemoteConfirmed || isRemoteSynced,
    swapToLive: shouldSwapToLive({
      isLocalSynced,
      ydocNonEmpty,
      collabSynced: isCollabSynced(
        yjsConnectionStatus,
        isLocalSynced && isRemoteSynced,
      ),
    }),
  };
}

interface PageEditorProps {
  pageId: string;
  editable: boolean;
  content: any;
  canComment?: boolean;
  // Ф7 (#643) — the live REST body has not resolved for THIS page yet
  // (`isLoading || !livePage` in page.tsx). Owns the SKELETON state: while the
  // static copy is up and no authoritative content exists (no REST body AND the
  // local ydoc is not reconciled), show a skeleton rather than an empty editor
  // or another page's static copy. Absent ⇒ false.
  bodyContentPending?: boolean;
}

export default function PageEditor({
  pageId,
  editable,
  content,
  canComment,
  bodyContentPending,
}: PageEditorProps) {
  const { t } = useTranslation();
  const collaborationURL = useCollaborationUrl();
  const isComponentMounted = useRef(false);
  const editorRef = useRef<Editor | null>(null);

  useEffect(() => {
    isComponentMounted.current = true;
  }, []);

  const [currentUser] = useAtom(currentUserAtom);
  // #626 — the (workspace, user) scope that namespaces this page's local ydoc
  // database, so a shared browser never serves one user's local body to another.
  // Stable for the editor's lifetime: the editor only mounts after `/me`
  // resolves, and a user switch tears it down (full-page nav / remount).
  const ydocScopeKey = useAtomValue(scopeKeyAtom);
  const [, setEditor] = useAtom(pageEditorAtom);
  const setCollabProvider = useSetAtom(collabProviderAtom);
  const [, setAsideState] = useAtom(asideStateAtom);
  const [, setActiveCommentId] = useAtom(activeCommentIdAtom);
  const [showCommentPopup, setShowCommentPopup] = useAtom(showCommentPopupAtom);
  const [showReadOnlyCommentPopup] = useAtom(showReadOnlyCommentPopupAtom);
  const bodyDbName = useMemo(
    () => pageYdocDbName(ydocScopeKey, pageId),
    [ydocScopeKey, pageId],
  );
  // #709 — the collab session this editor is bound to, owned by the
  // page-session cache. Seeded in render from a WARM session, so the editor —
  // created in render, before any effect — is bound to it from the first frame;
  // the acquire effect below rebinds when the cache hands out another one. Only
  // the session of the CURRENT page counts: a page switch without a remount
  // must never bind the previous page's session (#564).
  const [boundSession, setBoundSession] = useState(() =>
    peekWarmSession(bodyDbName),
  );
  const activeSession =
    boundSession?.dbName === bodyDbName ? boundSession : null;
  const [mountSessionFlags] = useState(() =>
    activeSession ? flagsFromSession(activeSession, false) : null,
  );
  const [isLocalSynced, setIsLocalSynced] = useState(
    mountSessionFlags?.isLocalSynced ?? false,
  );
  const [isRemoteSynced, setIsRemoteSynced] = useState(
    mountSessionFlags?.isRemoteSynced ?? false,
  );
  // #564 — the local ydoc actually holds body content (y-indexeddb emits
  // "synced" for an EMPTY doc too, so the event alone proves nothing).
  const [ydocNonEmpty, setYdocNonEmpty] = useState(
    mountSessionFlags?.ydocNonEmpty ?? false,
  );
  // #564 — the remote room confirmed a sync at least once for THIS page. Sticky
  // (a later disconnect does not revoke it, matching today's post-sync offline
  // editing), reset on page switch. This — NOT the static->live swap — is what
  // makes the body editable.
  const [isRemoteConfirmed, setIsRemoteConfirmed] = useState(
    mountSessionFlags?.isRemoteConfirmed ?? false,
  );
  // Mirror for the Yjs write guard, which is read from a ProseMirror plugin and
  // must see the CURRENT value without recreating the editor.
  const isRemoteConfirmedRef = useRef(
    mountSessionFlags?.isRemoteConfirmed ?? false,
  );
  // Ф7 (#643), part 7 — the DURABLE reconciliation mark (Ф4's reconciledAt),
  // keyed by the scoped ydoc DB name, read once per (scope, page). Deliberately
  // NOT the session-scoped `isRemoteConfirmed` (which starts false, never
  // persisted → forever false offline): keying the new skeleton decision on the
  // session flag would cement a gate that a future offline-editing phase must
  // rip out. A reconciliation that happens DURING this session is covered by
  // `isRemoteConfirmed` in `bodyReconciled` below.
  const durablyReconciled = useMemo(
    () => getReconciledAt(bodyDbName) !== undefined,
    [bodyDbName],
  );
  const setBodyLocalOnly = useSetAtom(bodyLocalOnlyAtom);
  const setBodyWriteBlocked = useSetAtom(bodyWriteBlockedAtom);
  const [yjsConnectionStatus, setYjsConnectionStatus] = useAtom(
    yjsConnectionStatusAtom,
  );
  const menuContainerRef = useRef(null);
  // Keeps the collab-token query observed and fetched; the session's token
  // callback reads it from the query cache (#709).
  useCollabToken();
  const { isIdle, resetIdle } = useIdle(FIVE_MINUTES, { initialState: false });
  const documentState = useDocumentVisibility();
  const { pageSlug } = useParams();
  const slugId = extractPageSlugId(pageSlug);
  const currentPageEditMode = useAtomValue(currentPageEditModeAtom);
  const setDictationAvailability = useSetAtom(dictationAvailabilityAtom);
  const canScroll = useCallback(
    () => Boolean(isComponentMounted.current && editorRef.current),
    [isComponentMounted],
  );
  const { handleScrollTo } = useEditorScroll({ canScroll });
  // #709 — take this page's collab session from the cache (warm → reused,
  // otherwise created; the session factory there carries the #707 attach
  // logic) and hand it back on unmount / page switch, which PARKS it.
  useEffect(() => {
    const s = acquirePageSession({
      dbName: bodyDbName,
      pageId,
      slugId,
      scopeKey: ydocScopeKey,
      collaborationURL,
    });
    if (s !== boundSession) setBoundSession(s);
    // #370 — publish the provider so the header menu can emit save-version.
    setCollabProvider(s.remote);
    return () => {
      setCollabProvider(null);
      releasePageSession(s);
    };
  }, [bodyDbName]);

  // Marks the socket as "disconnected BY US for being idle+hidden". Only such
  // a disconnect is ours to undo, and only once per transition — see
  // `decideSocketIdleAction` for why a level-triggered `socket.connect()`
  // destroys Hocuspocus's reconnect backoff.
  const idleDisconnectedRef = useRef(false);

  // Only connect/disconnect on tab/idle, not destroy
  useEffect(() => {
    if (!activeSession) return;
    const socket = activeSession.socket;

    const action = decideSocketIdleAction({
      isIdle,
      documentState,
      status: yjsConnectionStatus,
      idleDisconnected: idleDisconnectedRef.current,
    });

    if (action === "disconnect") {
      idleDisconnectedRef.current = true;
      socket.disconnect();
      return;
    }
    if (action === "connect") {
      idleDisconnectedRef.current = false;
      resetIdle();
      socket.connect();
    }
  }, [
    isIdle,
    documentState,
    yjsConnectionStatus,
    activeSession,
    resetIdle,
  ]);

  // `pageId` is a dependency on purpose: the session belongs to one page, so
  // without it a page switch that does not remount would leave the extensions
  // (and therefore the editor) bound to the previous page's provider / ydoc
  // (#564).
  const extensions = useMemo(() => {
    if (!activeSession || !currentUser?.user) {
      return mainExtensions;
    }

    const session = activeSession;
    // #709 — the bound session is alive. NOT `holder === 'active'`: between the
    // render and the acquire effect a warm session is still formally parked,
    // and UniqueID legitimately writes ids in that window.
    const sessionLive = () => session.alive;

    return [
      ...mainExtensions,
      ...collabExtensions(session.remote, currentUser?.user),
      // #564, guard 2 (Yjs-level half): while the body is live but the remote
      // room has not confirmed a sync, NO local doc mutation may reach the Y.Doc
      // — not a keystroke, not a plugin's appendTransaction. Both conditions are
      // read live, so flipping them never recreates the editor. #709 — a write
      // into a DESTROYED session (evicted between the render that bound it and
      // the acquire effect) is rejected too.
      createBodyWriteGuard({
        canWrite: () => sessionLive() && isRemoteConfirmedRef.current,
      }),
    ];
  }, [activeSession, currentUser?.user, pageId]);

  // Stable editorProps for the static read-only copy. Its EditorProvider has
  // `deps=[]`, so TipTap compares options by reference on every render and calls
  // setOptions -> view.setProps (a full view update) on any mismatch. A fresh
  // object literal here re-rendered the whole static body on every PageEditor
  // render during page open (~0.2 s each on a 400K-char page).
  const staticEditorProps = useMemo(
    () => ({ attributes: { "aria-label": t("Page content") } }),
    [t],
  );

  // getJSON() serialization + cache write live in the hook, off the keystroke
  // path, and flush on unmount so the last snapshot survives navigation (#343).
  // MUST be declared before useEditor: React runs effect cleanups in declaration
  // order on unmount, so the flush must run before the editor is torn down.
  const debouncedUpdateContent = usePageContentCache(editorRef, slugId);

  const editor = useEditor(
    {
      extensions,
      // Ф7 (#643) — a CONSTANT `false`, NOT the live `editable`, and `editable`
      // is out of the deps below. `editable` (= derivePageChromeCanEdit(livePage))
      // flips false→true when `/pages/info` lands; if it were an option dep the
      // editor would be destroyed+recreated at the exact measured moment (a visual
      // jump in the Ф3 window). The `editor.setEditable(isBodyEditable(...))`
      // effect below is the SOLE owner of editability — it already forces `false`
      // on mount (static / not-yet-remote-confirmed), so seeding `false` here is
      // behavior-identical while removing the recreation. `editable` participates
      // in no other editor-option closure (it is only read in the render body).
      editable: false,
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: {
        scrollThreshold: 80,
        scrollMargin: 80,
        attributes: {
          "aria-label": t("Page content"),
        },
        handleDOMEvents: {
          keydown: (_view, event) => {
            if (platformModifierKey(event) && event.code === "KeyS") {
              event.preventDefault();
              return true;
            }
            if (platformModifierKey(event) && event.code === "KeyK") {
              openSearchSpotlight();
              return true;
            }
            if (["ArrowUp", "ArrowDown", "Enter"].includes(event.key)) {
              const slashCommand = document.querySelector("#slash-command");
              if (slashCommand) {
                return true;
              }
            }
            if (
              [
                "ArrowUp",
                "ArrowDown",
                "ArrowLeft",
                "ArrowRight",
                "Enter",
              ].includes(event.key)
            ) {
              const emojiCommand = document.querySelector("#emoji-command");
              if (emojiCommand) {
                return true;
              }
            }
          },
        },
        handlePaste: (_view, event) => {
          if (!editorRef.current) return false;

          return handlePaste(
            editorRef.current,
            event,
            pageId,
            currentUser?.user.id,
          );
        },
        handleDrop: (_view, event, _slice, moved) => {
          if (!editorRef.current) return false;

          return handleFileDrop(editorRef.current, event, moved, pageId);
        },
      },
      onCreate({ editor }) {
        if (editor) {
          // @ts-ignore
          setEditor(editor);
          // @ts-ignore
          editor.storage.pageId = pageId;
          handleScrollTo(editor);
          editorRef.current = editor;

          // #355 — perf instrumentation. Skip ALL of it when telemetry is
          // disabled (F1 flag off) or this session isn't sampled: crucially NO
          // dispatch wrapping, so a non-collecting session pays zero
          // per-transaction cost.
          //
          // #639 — page_open_body_ms is NO LONGER measured here. onCreate fires
          // on TipTap object CONSTRUCTION (2-3x per open, on a still-skeleton
          // screen), not on paint, so it would report a false win once the
          // local-first gates are lifted. It moved to the body-paint latch below
          // (notePageBodyPaint), fed from the REAL paint points.
          if (isVitalsActive()) {
            // editor_tx_ms: time the SYNCHRONOUS part of applying each
            // transaction (state.apply + updateState) by wrapping the view's
            // dispatch. Only slow syncs (>8ms) are reported (see reportEditorTx),
            // so the common path adds just one performance.now() pair. Passive:
            // the original dispatch still runs unchanged.
            try {
              const view = editor.view as unknown as {
                dispatch: (tr: unknown) => void;
              };
              const originalDispatch = view.dispatch.bind(view);
              view.dispatch = (tr: unknown) => {
                const started = performance.now();
                originalDispatch(tr);
                const elapsed = performance.now() - started;
                try {
                  reportEditorTx(elapsed, editor.state.doc.content.size);
                } catch {
                  // never let telemetry break editing
                }
              };
            } catch {
              // if the view shape changes, skip editor_tx instrumentation
            }
          }
        }
      },
      onUpdate() {
        // Only schedule the debounce here — the whole-doc getJSON() serialization
        // happens INSIDE the debounced callback (see usePageContentCache), so it
        // no longer runs synchronously on every (local or remote) keystroke.
        debouncedUpdateContent();
      },
    },
    // Ф7 (#643) — `editable` intentionally removed (see the constant above): the
    // setEditable effect owns editability, so an `editable` flip no longer
    // recreates the editor.
    [pageId, extensions],
  );

  const editorIsEditable = useEditorState({
    editor,
    selector: (ctx) => {
      return ctx.editor?.isEditable ?? false;
    },
  });

  // Expose the gitmost native bridge only while an editable page editor is
  // mounted. Registering/tearing down here ties `ready` + `insertRecording`
  // to the lifetime of the current editable editor: readonly/share pages and
  // page switches re-run this effect (deps: live editable flag + pageId),
  // recreating the closure over the active editor/pageId so a recording always
  // targets whatever page is active at call time.
  useEffect(() => {
    if (!editor || !editor.isEditable) return;

    const w = window as unknown as { gitmost?: Partial<GitmostBridge> };
    w.gitmost = w.gitmost || {};
    w.gitmost.version = 1;
    w.gitmost.ready = true;

    const insertRecording = (
      payload: GitmostInsertRecordingPayload,
    ): Promise<GitmostInsertRecordingResult> =>
      gitmostInsertRecordingIntoEditor(editor, pageId, payload);

    w.gitmost.insertRecording = insertRecording;

    return () => {
      // Only tear down if our registration is still the active one. With
      // React's mount-before-unmount ordering, a newer PageEditor instance may
      // have already replaced the bridge; clearing it here would disable the
      // live editor's bridge.
      if (w.gitmost && w.gitmost.insertRecording === insertRecording) {
        w.gitmost.ready = false;
        delete w.gitmost.insertRecording;
      }
    };
  }, [editor, pageId, editorIsEditable]);

  const handleActiveCommentEvent = (event) => {
    const { commentId, resolved } = event.detail;

    if (resolved) {
      return;
    }

    // #683 `comments_open` — clicking an inline comment mark also opens the
    // aside (bypassing use-toggle-aside), so mark the op here too or this heavy
    // open path (the #340 300+-comment scenario is usually reached this way)
    // would be systematically under-sampled. Marking is idempotent: the measure
    // in comment-list-with-tabs consumes it, and a no-op if no mark exists.
    markOperationStart("comments_open");
    setActiveCommentId(commentId);
    setAsideState({ tab: "comments", isAsideOpen: true });

    //wait if aside is closed
    setTimeout(() => {
      const selector = `div[data-comment-id="${commentId}"]`;
      const commentElement = document.querySelector(selector);
      commentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 400);
  };

  useEffect(() => {
    document.addEventListener("ACTIVE_COMMENT_EVENT", handleActiveCommentEvent);
    return () => {
      document.removeEventListener(
        "ACTIVE_COMMENT_EVENT",
        handleActiveCommentEvent,
      );
    };
  }, []);

  // Close the right panel (and clear transient comment UI) when NAVIGATING to a
  // different page — but NOT on the initial mount, or a reload would immediately
  // clobber the now-persisted aside state (asideStateAtom) that was restored from
  // localStorage, defeating "open panel survives reload". Skip the first run;
  // only real pageId transitions reset. activeCommentId/showCommentPopup start
  // null/false on a fresh mount anyway, so skipping the mount run drops nothing.
  const asideResetPageIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (asideResetPageIdRef.current === null) {
      asideResetPageIdRef.current = pageId;
      return;
    }
    if (asideResetPageIdRef.current === pageId) return;
    asideResetPageIdRef.current = pageId;
    setActiveCommentId(null);
    setShowCommentPopup(false);
    setAsideState({ tab: "", isAsideOpen: false });
  }, [pageId]);

  const isSynced = isLocalSynced && isRemoteSynced;

  const hasConnectedOnceRef = useRef(false);
  // #709 — a warm session swaps on the very first render: the live editor is
  // built straight from it and the static copy never mounts.
  const [showStatic, setShowStatic] = useState(
    !mountSessionFlags?.swapToLive,
  );
  // #564 — the swap happened EARLY (from the local ydoc, before remote sync), so
  // the height reservation must be released on the live editor's first laid-out
  // frame rather than waiting for it to match the static copy's height (guard 6).
  const [earlySwap, setEarlySwap] = useState(false);
  // #641, part 6 — offline hysteresis latch. Set once the live-local body is on
  // screen and we are really offline; cleared only by a real remote sync (below)
  // or a page switch (the reset block). Holds the banner steady across
  // Hocuspocus's forever-retry Connecting/Disconnected flaps.
  const [stickyOffline, setStickyOffline] = useState(false);
  // #641, part 5 — the offline UI is driven by `navigator.onLine` AND the collab
  // socket status (which already has a 7500ms fallback), not by a query error
  // alone. Reactive via the online/offline events so a real network drop flips
  // the banner without waiting for the socket timeout.
  const [browserOffline, setBrowserOffline] = useState(
    () => typeof navigator !== "undefined" && navigator.onLine === false,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setBrowserOffline(navigator.onLine === false);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // #564 — a page switch that does NOT remount this component (page.tsx keys
  // FullEditor by page.id today, but nothing here may rely on that) must not
  // carry the previous page's sync state over: with local-first that would swap
  // the new page straight to a live editor on the strength of the OLD page's
  // flags, i.e. paint the previous page's ydoc state. Reset during render, so it
  // lands BEFORE any effect of the new pageId runs (React's sanctioned
  // "adjust state when a prop changes" pattern). #709 — also keyed by the
  // session identity (the cache may hand out another session than the one bound
  // in render); the flags come from the new session, the defaults without one.
  const [syncStateKey, setSyncStateKey] = useState({
    pageId,
    session: activeSession,
  });
  if (
    syncStateKey.pageId !== pageId ||
    syncStateKey.session !== activeSession
  ) {
    setSyncStateKey({ pageId, session: activeSession });
    const flags = activeSession ? flagsFromSession(activeSession, false) : null;
    setIsLocalSynced(flags?.isLocalSynced ?? false);
    setIsRemoteSynced(flags?.isRemoteSynced ?? false);
    setYdocNonEmpty(flags?.ydocNonEmpty ?? false);
    setIsRemoteConfirmed(flags?.isRemoteConfirmed ?? false);
    isRemoteConfirmedRef.current = flags?.isRemoteConfirmed ?? false;
    setShowStatic(!flags?.swapToLive);
    setEarlySwap(false);
    setStickyOffline(false);
    hasConnectedOnceRef.current = false;
    // NOTE: the jotai stores (bodyLocalOnlyAtom / bodyWriteBlockedAtom) are
    // deliberately NOT written here. Setting an atom other components subscribe
    // to during THIS component's render phase is a React violation ("Cannot
    // update a component while rendering a different component"). They are
    // published from the effects below instead, which re-run on this very render
    // because the state reset above recomputes their inputs.
  }

  // #709 — follow the bound session. Runs after the render that carried the
  // reset block. Subscribe FIRST, then re-read everything at once, so an event
  // landing between that render and the subscription is not lost; every
  // notification re-reads everything again. The listener is called
  // synchronously from the session's handlers — inside the provider's "synced"
  // emit it opens the write guard (`isRemoteConfirmedRef`) before any
  // extension's own "synced" listener runs. `yjsConnectionStatusAtom` is
  // written only here, from the bound session: a parked socket never touches
  // it. The static -> live swap on these flags stays with the collab-sync
  // effect below (it captures the height reservation right before the swap).
  useEffect(() => {
    if (!activeSession) return;
    const s = activeSession;
    const apply = () => {
      const flags = flagsFromSession(s, isRemoteConfirmedRef.current);
      isRemoteConfirmedRef.current = flags.isRemoteConfirmed;
      setIsLocalSynced(flags.isLocalSynced);
      setYdocNonEmpty(flags.ydocNonEmpty);
      setIsRemoteSynced(flags.isRemoteSynced);
      setIsRemoteConfirmed(flags.isRemoteConfirmed);
      setYjsConnectionStatus(flags.yjsConnectionStatus);
    };
    const unsubscribe = s.subscribe(apply);
    apply();
    return unsubscribe;
  }, [activeSession]);

  // #639 — body-paint latency latch. Arm on mount / page switch (this also
  // starts the survivorship-bias timeout), then report `page_open_body_ms` from
  // whichever REAL paint point lands first. Keyed by pageId, so it is one-shot
  // per document: the static->live swap and any editor re-creation for the same
  // page cannot double-count. armBodyPaint/notePageBodyPaint are no-ops when
  // telemetry is off or this session isn't sampled.
  useEffect(() => {
    armBodyPaint(pageId);
    // Disarm on unmount / before re-arming for another page: if this page leaves
    // before it paints, drop the pending survivorship timer instead of emitting a
    // body_paint_timeout for a page the user already navigated away from.
    return () => disarmBodyPaint(pageId);
  }, [pageId]);

  // Static-copy paint: PageEditor only mounts after the page content resolved
  // (page.tsx shows a skeleton until then), so the server-seeded static copy IS
  // real body content the moment this branch is on screen.
  useEffect(() => {
    if (showStatic) notePageBodyPaint(pageId);
  }, [showStatic, pageId]);

  // Live-editor paint: after the static->live swap the collab-bound editor
  // renders the body. Whichever branch paints first wins the one-shot latch.
  useEffect(() => {
    if (!showStatic && editor) notePageBodyPaint(pageId);
  }, [showStatic, editor, pageId]);

  // Reserved height held across the static -> live editor swap. The live editor
  // lays out its content over a few frames, so replacing the (full-height) static
  // copy with it momentarily shrinks the document; the browser then clamps window
  // scroll to the top, which yanked the reader off their restored reading position
  // (and threw their scroll to 0 if they were scrolling at that moment). Pinning a
  // min-height on the swap wrapper keeps the document tall through the swap so the
  // scroll position simply survives. `null` = no reservation active.
  const swapWrapperRef = useRef<HTMLDivElement | null>(null);
  // Reserve/release wiring lives in the hook so its capture trigger and release
  // guard/cap are directly unit-testable. Capture stays synchronous at the swap
  // point (see the collab-sync effect below); the hook only owns the release.
  const { reservedHeight, captureReservation } = useSwapHeightReservation(
    showStatic,
    menuContainerRef,
    earlySwap,
  );

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (yjsConnectionStatus === WebSocketStatus.Connecting || !isSynced) {
        setYjsConnectionStatus(WebSocketStatus.Disconnected);
      }
    }, 7500);

    return () => clearTimeout(timeout);
  }, [yjsConnectionStatus, isSynced]);
  useEffect(() => {
    if (!editor) return;
    // The body is editable ONLY once the remote room has confirmed a sync
    // (#564, guard 2). With local-first the live editor can be on screen long
    // before that (painted from the local ydoc), so gating on `!showStatic`
    // alone would re-open #218 (keystrokes into an unreconciled doc) and risk
    // clobbering newer remote content on merge.
    editor.setEditable(
      isBodyEditable({
        editable,
        inEditMode: currentPageEditMode === PageEditMode.Edit,
        showStatic,
        isRemoteConfirmed,
      }),
    );
  }, [currentPageEditMode, editor, editable, showStatic, isRemoteConfirmed]);

  // Publish whether dictation can start and, if not, the cause-specific reason
  // the mic button surfaces. Recomputed on the same signals that drive body
  // editability so the tooltip never lies about the current state (#309): in the
  // pre-remote live window the reason is "connecting"/"offline", NOT "read-only".
  useEffect(() => {
    setDictationAvailability(
      computeDictationAvailability({
        editable,
        inEditMode: currentPageEditMode === PageEditMode.Edit,
        showStatic,
        isRemoteConfirmed,
        isDisconnected: yjsConnectionStatus === WebSocketStatus.Disconnected,
      }),
    );
  }, [
    editable,
    currentPageEditMode,
    showStatic,
    isRemoteConfirmed,
    yjsConnectionStatus,
    setDictationAvailability,
  ]);

  useEffect(() => {
    const collabSynced = isCollabSynced(yjsConnectionStatus, isSynced);
    if (collabSynced && !isRemoteConfirmedRef.current) {
      // Sticky: the remote room has reconciled this page's doc at least once, so
      // local writes can no longer clobber unseen server content. A later drop
      // does not revoke it (today's post-sync offline editing is unchanged).
      isRemoteConfirmedRef.current = true;
      setIsRemoteConfirmed(true);
    }
    if (!hasConnectedOnceRef.current && collabSynced) {
      hasConnectedOnceRef.current = true;
    }
    if (!showStatic) return;
    if (
      !shouldSwapToLive({
        isLocalSynced,
        ydocNonEmpty,
        collabSynced,
      })
    ) {
      return;
    }
    // Capture the current (static, full-height) content height BEFORE the swap
    // so the wrapper can reserve it while the live editor lays out — otherwise
    // the transient shrink clamps window scroll to the top.
    captureReservation(swapWrapperRef.current?.offsetHeight ?? null);
    setEarlySwap(!collabSynced);
    setShowStatic(false);
  }, [
    yjsConnectionStatus,
    isSynced,
    isLocalSynced,
    ydocNonEmpty,
    showStatic,
  ]);

  // #564 — re-run the plugin appendTransaction pass once writes are allowed, for
  // the plugins whose pass the guard rejected during the read-only window.
  //
  // Scope, precisely: an EMPTY transaction only revives plugins whose
  // appendTransaction does NOT require `docChanged` (TrailingNode is the one that
  // matters — it re-appends the trailing paragraph). It does NOT revive
  // @tiptap/extension-unique-id, whose appendTransaction is `docChanged`-gated —
  // that extension is instead handled at the source, by opening the guard
  // synchronously inside the provider's "synced" emit (the session listener
  // above, notified from the cache's onSyncedHandler).
  useEffect(() => {
    if (!isRemoteConfirmed || !editor || editor.isDestroyed) {
      return;
    }
    editor.view.dispatch(editor.state.tr);
  }, [isRemoteConfirmed, editor]);

  // #564, guard 2 — publish the "programmatic writes are being dropped" window
  // so the paths that write to the body without typing (history restore, comment
  // resolve/delete mark updates) can refuse instead of silently doing nothing and
  // reporting success. Mirrors the guard's own predicate exactly.
  const bodyWriteBlocked = !isRemoteConfirmed;
  useEffect(() => {
    setBodyWriteBlocked(bodyWriteBlocked);
    return () => setBodyWriteBlocked(false);
  }, [bodyWriteBlocked, setBodyWriteBlocked]);

  // #641, part 6 — drive the hysteresis latch. Set it once the live-local body is
  // on screen and we are really offline (dead socket OR the browser reports
  // offline); clear it the instant a real remote sync confirms. The reset block
  // above additionally clears it on a page switch.
  const reallyOffline =
    yjsConnectionStatus === WebSocketStatus.Disconnected || browserOffline;
  useEffect(() => {
    if (isRemoteConfirmed) {
      setStickyOffline(false);
      return;
    }
    if (!showStatic && reallyOffline) setStickyOffline(true);
  }, [isRemoteConfirmed, showStatic, reallyOffline]);

  // #564, guards 4+5 — what the user is told about the un-reconciled state.
  const bodyIndicator = computeBodyIndicator({
    showStatic,
    isRemoteConfirmed,
    isDisconnected: reallyOffline,
    canEdit: editable && currentPageEditMode === PageEditMode.Edit,
    stickyOffline,
  });

  // The "offline, showing the cached copy" state is published for FullEditor, so
  // the banner can cover the page CHROME as well as the body (guard 5).
  useEffect(() => {
    setBodyLocalOnly({ isOffline: bodyIndicator === "offline" });
    return () => setBodyLocalOnly({ isOffline: false });
  }, [bodyIndicator, setBodyLocalOnly]);

  // Restore the reader's scroll position across the static -> live editor swap.
  // The wiring (early pre-paint restore + post-swap re-assert) lives in the hook
  // so its triggers/guard are directly unit-testable.
  useScrollRestoreOnSwap(pageId, editor, showStatic);

  // The quiet pre-sync badge. Same markup as before, but now rendered in BOTH
  // branches: after an early local-first swap the body is live yet still
  // read-only, and that window needs the very same (unobtrusive) signal — while
  // a real disconnect gets the page-wide banner instead (guard 4).
  const connectingBadge = bodyIndicator === "connecting" && (
    <div
      role="status"
      aria-live="polite"
      className="print-hide"
      data-testid="body-connecting-badge"
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        zIndex: 2,
        padding: "2px 8px",
        fontSize: "12px",
        borderRadius: "4px",
        background: "var(--mantine-color-gray-light)",
        color: "var(--mantine-color-dimmed)",
        pointerEvents: "none",
      }}
    >
      {t("Connecting… (read-only)")}
    </div>
  );

  // Ф7 (#643), parts 3 + 7 — the BODY has three states, owned here:
  //   1. local ydoc synced + NON-EMPTY → live read-only editor (`!showStatic`);
  //   2. ydoc empty/not-synced, authoritative content exists → static copy;
  //   3. ydoc empty/not-synced, NO authoritative content yet → SKELETON.
  // "Authoritative content" = a resolved live REST body (`!bodyContentPending`)
  // OR a reconciled local ydoc (`bodyReconciled`: durable reconciledAt, or the
  // session confirmation). Deriving the skeleton from `bodyContentPending`/
  // reconciliation — NOT from a falsy `content` — is load-bearing: a genuinely
  // LOADED-EMPTY page, and a reconciled-but-empty page revisited offline, both
  // render an empty static copy, never an eternal skeleton. A non-empty local
  // ydoc has already swapped to the live editor, so this only gates the static
  // window.
  const bodyReconciled = durablyReconciled || isRemoteConfirmed;
  const showBodySkeleton =
    showStatic && !!bodyContentPending && !bodyReconciled;

  return (
    <TransclusionLookupProvider>
      <PageEmbedLookupProvider>
        <PageEmbedAncestryProvider hostPageId={pageId}>
          <div
            ref={swapWrapperRef}
            style={
              reservedHeight != null ? { minHeight: reservedHeight } : undefined
            }
          >
            {showBodySkeleton ? (
              /* Ф7 (#643) — no authoritative body yet (no live REST content AND
                 the local ydoc is neither non-empty nor reconciled). A skeleton,
                 NOT an empty editor (the static `EditorProvider` has `deps=[]`
                 and never re-reads `content`, so a `content=undefined` mount
                 would stay blank forever) and NOT another page's static copy. */
              <BodySkeleton />
            ) : showStatic ? (
              <div style={{ position: "relative" }}>
                {/* Surface the pre-sync read-only window so edits typed before the
              collab provider connects aren't silently swallowed (#218). Shown
              only when the user is otherwise allowed to edit. */}
                {connectingBadge}
                <StaticBodyEditor
                  content={content}
                  editorProps={staticEditorProps}
                />
              </div>
            ) : (
              <div
                className="editor-container"
                style={{ position: "relative" }}
              >
                {/* Local-first read-only window: the body is live from the local ydoc
              but the remote room has not confirmed yet (#564). */}
                {connectingBadge}
                <div ref={menuContainerRef}>
                  <EditorContent editor={editor} />

                  <CommentHoverPreview
                    pageId={pageId}
                    containerRef={menuContainerRef}
                  />

                  {editor && (
                    <SearchAndReplaceDialog
                      editor={editor}
                      editable={editable}
                    />
                  )}

                  {editor && editorIsEditable && (
                    <div>
                      <EditorLinkMenu editor={editor} />
                      <EditorBubbleMenu editor={editor} />
                      <TableMenu editor={editor} />
                      <TableHandlesLayer editor={editor} />
                      <ImageMenu editor={editor} />
                      <VideoMenu editor={editor} />
                      <AudioMenu editor={editor} />
                      <PdfMenu editor={editor} />
                      <CalloutMenu editor={editor} />
                      <SubpagesMenu editor={editor} />
                      <ExcalidrawMenu editor={editor} />
                      <DrawioMenu editor={editor} />
                      <ColumnsMenu editor={editor} />
                    </div>
                  )}
                  {/* #564 — NOT offered while the write guard is rejecting: this menu
                only creates comments, and a comment created here would land in
                the DB while its inline mark was dropped by the guard, leaving an
                anchorless comment. On develop this window did not exist (the live
                editor was only ever shown post-sync), so gating it restores
                exactly that reachability. */}
                  {editor &&
                    !editorIsEditable &&
                    !bodyWriteBlocked &&
                    (editable || canComment) &&
                    activeSession && (
                      <ReadonlyBubbleMenu editor={editor} />
                    )}
                  {showCommentPopup && (
                    <CommentDialog editor={editor} pageId={pageId} />
                  )}
                  {showReadOnlyCommentPopup && (
                    <CommentDialog editor={editor} pageId={pageId} readOnly />
                  )}
                  {editor && editorIsEditable && <PageEmbedPicker />}
                </div>
                <div
                  onClick={() => editor.commands.focus("end")}
                  style={{ paddingBottom: "20vh" }}
                ></div>
              </div>
            )}
          </div>
        </PageEmbedAncestryProvider>
      </PageEmbedLookupProvider>
    </TransclusionLookupProvider>
  );
}

// The static read-only copy of the body, shown until the live editor swaps in.
function StaticBodyEditor({
  content,
  editorProps,
}: {
  content: any;
  editorProps: React.ComponentProps<typeof EditorProvider>["editorProps"];
}) {
  const editorRef = useRef<Editor | null>(null);
  const onBeforeCreate = useCallback(({ editor }: { editor: Editor }) => {
    editorRef.current = editor;
  }, []);

  // Destroy the editor in this layout cleanup, which React runs BEFORE the
  // child EditorContent's componentWillUnmount. That unmount otherwise calls
  // view.setProps({ nodeViews: {} }) on a still-live view, which redraws the
  // whole body once more right before it is thrown away (~150 ms on a
  // 400K-char page); on a destroyed editor it skips that call.
  // injectCSS is off because this synchronous destroy would otherwise remove
  // tiptap's shared <style data-tiptap-style> when no other .tiptap element is
  // in the document yet (page-to-page navigation); the title and live editors
  // are constructed earlier and own that tag.
  useLayoutEffect(() => () => editorRef.current?.destroy(), []);

  return (
    <EditorProvider
      editable={false}
      immediatelyRender={true}
      injectCSS={false}
      extensions={mainExtensions}
      content={content}
      editorProps={editorProps}
      onBeforeCreate={onBeforeCreate}
    />
  );
}

// Ф7 (#643) — the body-only loading placeholder (the title + byline chrome
// already paints from the #563 meta cache above this editor). Approximates the
// first content lines so a first visit / unresolved body no longer flashes an
// empty editor.
function BodySkeleton() {
  return (
    <div data-testid="body-skeleton" aria-hidden>
      <Skeleton height={16} mt="xl" radius="sm" />
      <Skeleton height={16} mt="sm" radius="sm" />
      <Skeleton height={16} mt="sm" width="85%" radius="sm" />
      <Skeleton height={16} mt="sm" width="70%" radius="sm" />
    </div>
  );
}
