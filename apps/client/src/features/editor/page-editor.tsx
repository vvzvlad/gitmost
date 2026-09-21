import "@/features/editor/styles/index.css";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import {
  HocuspocusProvider,
  onStatusParameters,
  WebSocketStatus,
  HocuspocusProviderWebsocket,
  onSyncedParameters,
  onStatelessParameters,
} from "@hocuspocus/provider";
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
import { notifications } from "@mantine/notifications";
import { Skeleton } from "@mantine/core";
import { getCollabToken } from "@/features/auth/services/auth-service";
import {
  VERSION_SAVED_MESSAGE_TYPE,
  type VersionSavedMessage,
  saveVersionPending,
} from "@/features/page-history/version-messages";
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
import { queryClient } from "@/main.tsx";
import { IPage } from "@/features/page/types/page.types.ts";
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
import { jwtDecode } from "jwt-decode";
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
import {
  createBodyWriteGuard,
  isYdocBodyNonEmpty,
} from "@/features/editor/local-first-body";
import {
  pageYdocDbName,
  pageYdocRoomName,
  registerPageYdoc,
  rememberYdocDbName,
  unregisterPageYdoc,
} from "@/features/editor/page-ydoc-eviction";
import { canOpenLocalYdoc } from "@/features/editor/page-ydoc-tombstones";
import {
  getReconciledAt,
  markReconciled,
} from "@/features/editor/page-ydoc-reconciled";
import { isSessionExpired } from "@/features/user/session-verified";
import { scopeKeyAtom } from "@/features/page/tree/atoms/open-tree-nodes-atom";
import { isLocalFirstEnabled } from "@/lib/config.ts";
import {
  armBodyPaint,
  disarmBodyPaint,
  isVitalsActive,
  markOperationStart,
  notePageBodyPaint,
  reportEditorTx,
} from "@/lib/telemetry/vitals";

interface PageEditorProps {
  pageId: string;
  editable: boolean;
  content: any;
  canComment?: boolean;
  // Ф7 (#643) — the live REST body has not resolved for THIS page yet
  // (`isLoading || !livePage` in page.tsx). Owns the SKELETON state: while the
  // static copy is up and no authoritative content exists (no REST body AND the
  // local ydoc is not reconciled), show a skeleton rather than an empty editor
  // or another page's static copy. Absent (legacy mount / flag OFF) ⇒ false.
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
  const [isLocalSynced, setIsLocalSynced] = useState(false);
  const [isRemoteSynced, setIsRemoteSynced] = useState(false);
  // #564 — the local ydoc actually holds body content (y-indexeddb emits
  // "synced" for an EMPTY doc too, so the event alone proves nothing).
  const [ydocNonEmpty, setYdocNonEmpty] = useState(false);
  // #564 — the remote room confirmed a sync at least once for THIS page. Sticky
  // (a later disconnect does not revoke it, matching today's post-sync offline
  // editing), reset on page switch. This — NOT the static->live swap — is what
  // makes the body editable.
  const [isRemoteConfirmed, setIsRemoteConfirmed] = useState(false);
  // Mirror for the Yjs write guard, which is read from a ProseMirror plugin and
  // must see the CURRENT value without recreating the editor.
  const isRemoteConfirmedRef = useRef(false);
  // Read the flag once per mount: a mid-session flip must not move the editor
  // between two different state machines.
  const localFirst = useMemo(() => isLocalFirstEnabled(), []);
  // Ф7 (#643), part 7 — the DURABLE reconciliation mark (Ф4's reconciledAt),
  // keyed by the scoped ydoc DB name, read once per (scope, page). Deliberately
  // NOT the session-scoped `isRemoteConfirmed` (which is `useState(false)`, never
  // persisted → forever false offline): keying the new skeleton decision on the
  // session flag would cement a gate that a future offline-editing phase must
  // rip out. A reconciliation that happens DURING this session is covered by
  // `isRemoteConfirmed` in `bodyReconciled` below.
  const bodyDbName = useMemo(
    () => pageYdocDbName(ydocScopeKey, pageId),
    [ydocScopeKey, pageId],
  );
  const durablyReconciled = useMemo(
    () => (localFirst ? getReconciledAt(bodyDbName) !== undefined : false),
    [localFirst, bodyDbName],
  );
  const setBodyLocalOnly = useSetAtom(bodyLocalOnlyAtom);
  const setBodyWriteBlocked = useSetAtom(bodyWriteBlockedAtom);
  const [yjsConnectionStatus, setYjsConnectionStatus] = useAtom(
    yjsConnectionStatusAtom,
  );
  const menuContainerRef = useRef(null);
  const { data: collabQuery, refetch: refetchCollabToken } = useCollabToken();
  // Always holds the latest collab token. The provider effect below runs once
  // per pageId, so a handler created inside it would otherwise close over a
  // stale `collabQuery`. Reading the ref gives the current token instead.
  const collabTokenRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    collabTokenRef.current = collabQuery?.token;
  }, [collabQuery?.token]);
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
  // Providers only created once per pageId
  const providersRef = useRef<{
    // #640 — remote-only when the page is tombstoned / scope unresolved / session
    // expired: the local persistence is then not constructed at all.
    local: IndexeddbPersistence | null;
    remote: HocuspocusProvider;
    socket: HocuspocusProviderWebsocket;
    ydoc: Y.Doc;
    dbName: string;
  } | null>(null);
  // #564 — the ACTIVE providers, tagged with the pageId they belong to, held in
  // STATE (not just the ref) so the extensions memo below can never bind the
  // editor to a provider from a different page. On a pageId change React renders
  // BEFORE the provider effect re-runs, so a memo reading `providersRef` would
  // rebuild the collab extensions against the PREVIOUS page's ydoc — and, since
  // the memo would not recompute again once the new providers landed, the editor
  // would stay bound to it for the rest of the page's life.
  const [activeProviders, setActiveProviders] = useState<{
    pageId: string;
    remote: HocuspocusProvider;
  } | null>(null);
  const providersReady =
    activeProviders !== null && activeProviders.pageId === pageId;

  useEffect(() => {
    // Guards every provider callback below: after this effect is cleaned up (page
    // switch / unmount) a late event from the destroyed providers must never
    // write sync state that now belongs to a DIFFERENT page.
    let disposed = false;
    if (!providersRef.current) {
      // #640, invariant 1 — the DB name is SCOPE-NAMESPACED, the collab ROOM name
      // is NOT. The room name must stay `page.<pageId>` or the server resolves the
      // wrong id and every collab connection breaks (see page-ydoc-eviction).
      const dbName = pageYdocDbName(ydocScopeKey, pageId);
      const roomName = pageYdocRoomName(pageId);
      // #640 — open LOCAL persistence only when it is safe to lean on local
      // content. Fail-closed on all three:
      //  - anon scope (not yet resolved): a signed-out/first-frame state must not
      //    write a body under `anon:anon` (invariant 2);
      //  - session expired past OFFLINE_GRACE (30d, part 6): refuse local body;
      //  - the page is TOMBSTONED (access revoked, part 5): y-indexeddb creates
      //    the DB on construction, so gating here — not at paint — is what keeps a
      //    revoked page from resurrecting an (empty) database every visit. Checked
      //    under BOTH aliases so a slugId-only tombstone still blocks.
      const scopeResolved = !ydocScopeKey.split(":").includes("anon");
      const openLocal =
        scopeResolved &&
        !isSessionExpired() &&
        canOpenLocalYdoc(dbName) &&
        canOpenLocalYdoc(pageYdocDbName(ydocScopeKey, slugId ?? pageId));
      const ydoc = new Y.Doc();
      const local = openLocal ? new IndexeddbPersistence(dbName, ydoc) : null;
      if (openLocal) {
        // Record the scoped DB name so the cross-user purge can delete it by name
        // on browsers without `indexedDB.databases()` (Firefox). Only when a DB is
        // actually created — a remote-only ydoc leaves nothing on disk.
        rememberYdocDbName(dbName);
      }
      const socket = new HocuspocusProviderWebsocket({
        url: collaborationURL,
      });
      const onLocalSyncedHandler = () => {
        if (disposed) return;
        setIsLocalSynced(true);
        // y-indexeddb emits "synced" even when the stored doc is EMPTY, so probe
        // the actual body fragment: an empty ydoc must NOT trigger the early swap
        // (it would blank the body until the network answers — guard 1).
        setYdocNonEmpty(isYdocBodyNonEmpty(ydoc));
      };
      const onStatusHandler = (event: onStatusParameters) => {
        if (disposed) return;
        setYjsConnectionStatus(event.status);
      };
      const onSyncedHandler = (event: onSyncedParameters) => {
        if (disposed) return;
        setIsRemoteSynced(event.state);
        // #564, guard 2 — THIS event IS the remote confirmation, so the write
        // guard must open SYNCHRONOUSLY here, inside the same emit.
        //
        // Load-bearing: extensions dispatch from `provider.on("synced")` and then
        // immediately unsubscribe. @tiptap/extension-unique-id is the canonical
        // one — its `createIds` runs in this very emit, does a single
        // `view.dispatch(tr)` and calls `provider.off("synced", ...)` right after.
        // If the guard were still closed at that instant (React state only lands
        // after a re-render), that transaction would be REJECTED and the
        // extension would already be gone — leaving every node without a
        // `data-id` for the life of the editor, which silently breaks comment
        // anchors, transclusions and the TOC. A later empty flush transaction
        // cannot repair it: UniqueID's appendTransaction requires `docChanged`.
        //
        // The React state below drives the UI and is intentionally async; the ref
        // is what the ProseMirror plugin reads.
        if (event.state) {
          isRemoteConfirmedRef.current = true;
          setIsRemoteConfirmed(true);
          // #640 R1 — durable "this ydoc reconciled with the server at least
          // once" mark, keyed by the scoped DB name. Introduced now, no consumers
          // yet; Ф7 (offline editing) reads THIS instead of the session-scoped
          // isRemoteConfirmed. See page-ydoc-reconciled for the forward-compat
          // purge/quarantine rule.
          markReconciled(dbName);
        }
      };
      const onStatelessHandler = ({ payload }: onStatelessParameters) => {
        if (disposed) return;
        try {
          const message = JSON.parse(payload);
          // #370 — a version was saved somewhere; live-refresh the history panel
          // on every client. Only the client that pressed Save (tracked by the
          // module-level flag) shows the confirmation toast.
          if (message?.type === VERSION_SAVED_MESSAGE_TYPE) {
            const versionMsg = message as VersionSavedMessage;
            queryClient.invalidateQueries({
              queryKey: ["page-history-list"],
            });
            if (saveVersionPending.current) {
              saveVersionPending.current = false;
              notifications.show({
                message: versionMsg.alreadySaved
                  ? t("Already saved as the latest version")
                  : t("Version saved"),
              });
            }
            return;
          }
          if (message?.type !== "page.updated" || !message.updatedAt) return;
          const pageData = queryClient.getQueryData<IPage>(["pages", slugId]);
          if (pageData) {
            queryClient.setQueryData(["pages", slugId], {
              ...pageData,
              updatedAt: message.updatedAt,
              ...(message.lastUpdatedBy && {
                lastUpdatedBy: message.lastUpdatedBy,
              }),
            });
          }
        } catch {
          // ignore unrelated stateless messages
        }
      };
      const onAuthenticationFailedHandler = () => {
        // Late auth failure after teardown: the socket below is already
        // destroyed, so reconnecting it would resurrect a dead provider (and,
        // after a page switch, connect to the WRONG page's room).
        if (disposed) return;
        // Read the latest token via the ref (the closure-captured `collabQuery`
        // may be stale). Guard the decode: a missing or unparseable token must
        // not throw "Invalid token specified" and should trigger a refresh so
        // the editor reconnects even when the initial token fetch failed.
        const token = collabTokenRef.current;
        let needsRefresh = true; // no/unparseable token -> fetch a fresh one and reconnect
        if (token) {
          try {
            // A token that decodes but lacks a numeric `exp` must be treated as
            // expired (`Date.now()/1000 >= undefined` is `false`, which would
            // otherwise skip the reconnect), so refresh on any missing/non-number exp.
            const exp = jwtDecode<{ exp?: number }>(token).exp;
            needsRefresh = typeof exp !== "number" || Date.now() / 1000 >= exp;
          } catch {
            needsRefresh = true;
          }
        }
        if (!needsRefresh) return;
        refetchCollabToken().then((result) => {
          if (disposed || !result.data?.token) return;
          socket.disconnect();
          setTimeout(() => {
            if (disposed) return;
            remote.configuration.token = result.data.token;
            socket.connect();
          }, 100);
        });
      };
      const remote = new HocuspocusProvider({
        websocketProvider: socket,
        // #640, invariant 1 — the un-namespaced ROOM name (`page.<pageId>`), never
        // the scoped DB name, so the server resolves the pageId via split('.')[1]
        // and every authenticated collab connection succeeds (#626 regression fix).
        name: roomName,
        document: ydoc,
        // Ф7 (#643) — a LAZY token callback, not a by-value token. Hocuspocus
        // accepts a (possibly async) function and awaits it before authenticating.
        // At t0 the collab-token query may not have resolved yet; passing an empty
        // token by value makes the server reject the socket → onAuthenticationFailed
        // → a 100ms reconnect, growing the read-only window on the very path Ф7
        // speeds up (and widening the #218 radius). The callback instead WAITS for
        // the token: it prefers the always-current ref, else ensures the query.
        token: async () =>
          collabTokenRef.current ??
          (
            await queryClient.ensureQueryData({
              queryKey: ["collab-token"],
              queryFn: () => getCollabToken(),
            })
          )?.token,
        onAuthenticationFailed: onAuthenticationFailedHandler,
        onStatus: onStatusHandler,
        onSynced: onSyncedHandler,
        onStateless: onStatelessHandler,
      });

      local?.on("synced", onLocalSyncedHandler);
      providersRef.current = { socket, local, remote, ydoc, dbName };
      // #564 guard 3 / #640 part 7 — hand the LIVE persistence to the global
      // 403/404 subscriber (installed at app level in main.tsx, because the
      // revoked-page case never mounts this component at all), keyed by both
      // aliases a page query can use. Registered whenever a local persistence was
      // actually opened, regardless of the flag: deleting revoked content is not
      // gated on the local-first experiment. This only makes eviction of a page
      // open RIGHT NOW cheaper/synchronous — the subscriber resolves pages this
      // session never opened from the persisted #563 meta cache on its own.
      if (local) {
        registerPageYdoc({
          dbName,
          persistence: local,
          keys: [pageId, slugId],
        });
      }
      // #370 — publish the provider so the header menu can emit save-version.
      setCollabProvider(remote);
      setActiveProviders({ pageId, remote });
    } else {
      setCollabProvider(providersRef.current.remote);
      setActiveProviders({ pageId, remote: providersRef.current.remote });
    }
    // Only destroy on final unmount
    return () => {
      disposed = true;
      setCollabProvider(null);
      setActiveProviders(null);
      const dbName = providersRef.current?.dbName;
      providersRef.current?.socket.destroy();
      providersRef.current?.remote.destroy();
      providersRef.current?.local?.destroy();
      providersRef.current = null;
      // The persistence is gone; keep only the pageId/slugId -> db-name alias
      // so a 403/404 landing AFTER unmount still deletes the IDB database.
      if (dbName) unregisterPageYdoc(dbName);
    };
  }, [pageId]);

  // Marks the socket as "disconnected BY US for being idle+hidden". Only such
  // a disconnect is ours to undo, and only once per transition — see
  // `decideSocketIdleAction` for why a level-triggered `socket.connect()`
  // destroys Hocuspocus's reconnect backoff.
  const idleDisconnectedRef = useRef(false);

  // Only connect/disconnect on tab/idle, not destroy
  useEffect(() => {
    if (!providersReady || !providersRef.current) return;
    const socket = providersRef.current.socket;

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
    providersReady,
    resetIdle,
  ]);

  // Attach the remote provider once it's ready (and again after a pageId swap
  // recreates it) to make sure the connection gets properly established. This
  // used to run in the render body — a side effect during render (#343, PART 7).
  // `attach()` is idempotent, so re-running it on these deps is safe.
  useEffect(() => {
    providersRef.current?.remote.attach();
  }, [providersReady, pageId]);

  // `pageId` is a dependency on purpose: the providers are recreated per pageId,
  // so without it a page switch that does not remount would leave the extensions
  // (and therefore the editor) bound to the DESTROYED provider / previous page's
  // ydoc (#564).
  const extensions = useMemo(() => {
    if (
      !activeProviders ||
      activeProviders.pageId !== pageId ||
      !currentUser?.user
    ) {
      return mainExtensions;
    }

    const remoteProvider = activeProviders.remote;

    return [
      ...mainExtensions,
      ...collabExtensions(remoteProvider, currentUser?.user),
      // #564, guard 2 (Yjs-level half): while the body is live but the remote
      // room has not confirmed a sync, NO local doc mutation may reach the Y.Doc
      // — not a keystroke, not a plugin's appendTransaction. Both predicates are
      // read live, so flipping them never recreates the editor.
      createBodyWriteGuard({
        isActive: () => localFirst,
        canWrite: () => isRemoteConfirmedRef.current,
      }),
    ];
  }, [activeProviders, currentUser?.user, pageId, localFirst]);

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
  const [showStatic, setShowStatic] = useState(true);
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
    if (!localFirst || typeof window === "undefined") return;
    const update = () => setBrowserOffline(navigator.onLine === false);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [localFirst]);

  // #564 — a page switch that does NOT remount this component (page.tsx keys
  // FullEditor by page.id today, but nothing here may rely on that) must not
  // carry the previous page's sync state over: with local-first that would swap
  // the new page straight to a live editor on the strength of the OLD page's
  // flags, i.e. paint the previous page's ydoc state. Reset during render, so it
  // lands BEFORE any effect of the new pageId runs (React's sanctioned
  // "adjust state when a prop changes" pattern).
  const [syncStatePageId, setSyncStatePageId] = useState(pageId);
  if (syncStatePageId !== pageId) {
    setSyncStatePageId(pageId);
    setIsLocalSynced(false);
    setIsRemoteSynced(false);
    setYdocNonEmpty(false);
    setIsRemoteConfirmed(false);
    isRemoteConfirmedRef.current = false;
    setShowStatic(true);
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
        localFirst,
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
    localFirst,
  ]);

  // #564 — re-run the plugin appendTransaction pass once writes are allowed, for
  // the plugins whose pass the guard rejected during the read-only window.
  //
  // Scope, precisely: an EMPTY transaction only revives plugins whose
  // appendTransaction does NOT require `docChanged` (TrailingNode is the one that
  // matters — it re-appends the trailing paragraph). It does NOT revive
  // @tiptap/extension-unique-id, whose appendTransaction is `docChanged`-gated —
  // that extension is instead handled at the source, by opening the guard
  // synchronously inside the provider's "synced" emit (see onSyncedHandler).
  useEffect(() => {
    if (!localFirst || !isRemoteConfirmed || !editor || editor.isDestroyed) {
      return;
    }
    editor.view.dispatch(editor.state.tr);
  }, [localFirst, isRemoteConfirmed, editor]);

  // #564, guard 2 — publish the "programmatic writes are being dropped" window
  // so the paths that write to the body without typing (history restore, comment
  // resolve/delete mark updates) can refuse instead of silently doing nothing and
  // reporting success. Mirrors the guard's own predicate exactly.
  const bodyWriteBlocked = localFirst && !isRemoteConfirmed;
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
    localFirst,
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
  // window. Flag OFF (or the legacy mount): `bodyContentPending` is false, so
  // this is never a skeleton — today's static→live behavior exactly.
  const bodyReconciled = durablyReconciled || isRemoteConfirmed;
  const showBodySkeleton =
    localFirst && showStatic && !!bodyContentPending && !bodyReconciled;

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
                <EditorProvider
                  editable={false}
                  immediatelyRender={true}
                  extensions={mainExtensions}
                  content={content}
                  editorProps={{
                    attributes: {
                      "aria-label": t("Page content"),
                    },
                  }}
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
                    providersRef.current && (
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
