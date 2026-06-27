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
import { useAtom, useAtomValue } from "jotai";
import useCollaborationUrl from "@/features/editor/hooks/use-collaboration-url";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import {
  currentPageEditModeAtom,
  pageEditorAtom,
  yjsConnectionStatusAtom,
} from "@/features/editor/atoms/editor-atoms";
import { asideStateAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom";
import {
  activeCommentIdAtom,
  showCommentPopupAtom,
  showReadOnlyCommentPopupAtom,
} from "@/features/comment/atoms/comment-atom";
import CommentDialog from "@/features/comment/components/comment-dialog";
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
import DrawioMenu from "./components/drawio/drawio-menu";
import { useCollabToken } from "@/features/auth/queries/auth-query.tsx";
import SearchAndReplaceDialog from "@/features/editor/components/search-and-replace/search-and-replace-dialog.tsx";
import { useDebouncedCallback, useDocumentVisibility } from "@mantine/hooks";
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
import { searchSpotlight } from "@/features/search/constants.ts";
import { useEditorScroll } from "./hooks/use-editor-scroll";
import { EditorLinkMenu } from "@/features/editor/components/link/link-menu";
import ColumnsMenu from "@/features/editor/components/columns/columns-menu.tsx";
import { TransclusionLookupProvider } from "@/features/editor/components/transclusion/transclusion-lookup-context";
import { PageEmbedLookupProvider } from "@/features/editor/components/page-embed/page-embed-lookup-context";
import { PageEmbedAncestryProvider } from "@/features/editor/components/page-embed/page-embed-ancestry-context";
import PageEmbedPicker from "@/features/editor/components/page-embed/page-embed-picker";
import { useTranslation } from "react-i18next";
import {
  isBodyEditable,
  isCollabSynced,
} from "@/features/editor/editor-sync-state";

interface PageEditorProps {
  pageId: string;
  editable: boolean;
  content: any;
  canComment?: boolean;
}

export default function PageEditor({
  pageId,
  editable,
  content,
  canComment,
}: PageEditorProps) {
  const { t } = useTranslation();
  const collaborationURL = useCollaborationUrl();
  const isComponentMounted = useRef(false);
  const editorRef = useRef<Editor | null>(null);

  useEffect(() => {
    isComponentMounted.current = true;
  }, []);

  const [currentUser] = useAtom(currentUserAtom);
  const [, setEditor] = useAtom(pageEditorAtom);
  const [, setAsideState] = useAtom(asideStateAtom);
  const [, setActiveCommentId] = useAtom(activeCommentIdAtom);
  const [showCommentPopup, setShowCommentPopup] = useAtom(showCommentPopupAtom);
  const [showReadOnlyCommentPopup] = useAtom(showReadOnlyCommentPopupAtom);
  const [isLocalSynced, setIsLocalSynced] = useState(false);
  const [isRemoteSynced, setIsRemoteSynced] = useState(false);
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
  const canScroll = useCallback(
    () => Boolean(isComponentMounted.current && editorRef.current),
    [isComponentMounted],
  );
  const { handleScrollTo } = useEditorScroll({ canScroll });
  // Providers only created once per pageId
  const providersRef = useRef<{
    local: IndexeddbPersistence;
    remote: HocuspocusProvider;
    socket: HocuspocusProviderWebsocket;
  } | null>(null);
  const [providersReady, setProvidersReady] = useState(false);

  useEffect(() => {
    if (!providersRef.current) {
      const documentName = `page.${pageId}`;
      const ydoc = new Y.Doc();
      const local = new IndexeddbPersistence(documentName, ydoc);
      const socket = new HocuspocusProviderWebsocket({
        url: collaborationURL,
      });
      const onLocalSyncedHandler = () => {
        setIsLocalSynced(true);
      };
      const onStatusHandler = (event: onStatusParameters) => {
        setYjsConnectionStatus(event.status);
      };
      const onSyncedHandler = (event: onSyncedParameters) => {
        setIsRemoteSynced(event.state);
      };
      const onStatelessHandler = ({ payload }: onStatelessParameters) => {
        try {
          const message = JSON.parse(payload);
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
          if (result.data?.token) {
            socket.disconnect();
            setTimeout(() => {
              remote.configuration.token = result.data.token;
              socket.connect();
            }, 100);
          }
        });
      };
      const remote = new HocuspocusProvider({
        websocketProvider: socket,
        name: documentName,
        document: ydoc,
        token: collabQuery?.token,
        onAuthenticationFailed: onAuthenticationFailedHandler,
        onStatus: onStatusHandler,
        onSynced: onSyncedHandler,
        onStateless: onStatelessHandler,
      });

      local.on("synced", onLocalSyncedHandler);
      providersRef.current = { socket, local, remote };
      setProvidersReady(true);
    } else {
      setProvidersReady(true);
    }
    // Only destroy on final unmount
    return () => {
      providersRef.current?.socket.destroy();
      providersRef.current?.remote.destroy();
      providersRef.current?.local.destroy();
      providersRef.current = null;
    };
  }, [pageId]);

  // Only connect/disconnect on tab/idle, not destroy
  useEffect(() => {
    if (!providersReady || !providersRef.current) return;
    const socket = providersRef.current.socket;

    if (
      isIdle &&
      documentState === "hidden" &&
      yjsConnectionStatus === WebSocketStatus.Connected
    ) {
      socket.disconnect();
      return;
    }
    if (
      documentState === "visible" &&
      yjsConnectionStatus === WebSocketStatus.Disconnected
    ) {
      resetIdle();
      socket.connect();
    }
  }, [isIdle, documentState, providersReady, resetIdle]);

  // Attach here, to make sure the connection gets properly established
  providersRef.current?.remote.attach();

  const extensions = useMemo(() => {
    if (!providersReady || !providersRef.current || !currentUser?.user) {
      return mainExtensions;
    }

    const remoteProvider = providersRef.current.remote;

    return [
      ...mainExtensions,
      ...collabExtensions(remoteProvider, currentUser?.user),
    ];
  }, [providersReady, currentUser?.user]);

  const editor = useEditor(
    {
      extensions,
      editable,
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
              searchSpotlight.open();
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
        }
      },
      onUpdate({ editor }) {
        if (editor.isEmpty) return;
        const editorJson = editor.getJSON();
        //update local page cache to reduce flickers
        debouncedUpdateContent(editorJson);
      },
    },
    [pageId, editable, extensions],
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

  const debouncedUpdateContent = useDebouncedCallback((newContent: any) => {
    const pageData = queryClient.getQueryData<IPage>(["pages", slugId]);

    if (pageData) {
      queryClient.setQueryData(["pages", slugId], {
        ...pageData,
        content: newContent,
      });
    }
  }, 3000);

  const handleActiveCommentEvent = (event) => {
    const { commentId, resolved } = event.detail;

    if (resolved) {
      return;
    }

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

  useEffect(() => {
    setActiveCommentId(null);
    setShowCommentPopup(false);
    setAsideState({ tab: "", isAsideOpen: false });
  }, [pageId]);

  const isSynced = isLocalSynced && isRemoteSynced;

  const hasConnectedOnceRef = useRef(false);
  const [showStatic, setShowStatic] = useState(true);

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
    // Keep the body read-only until the collab doc has synced (showStatic), so
    // early keystrokes on a freshly created page can't be lost (#218).
    editor.setEditable(
      isBodyEditable({
        editable,
        inEditMode: currentPageEditMode === PageEditMode.Edit,
        showStatic,
      }),
    );
  }, [currentPageEditMode, editor, editable, showStatic]);

  useEffect(() => {
    if (
      !hasConnectedOnceRef.current &&
      isCollabSynced(yjsConnectionStatus, isSynced)
    ) {
      hasConnectedOnceRef.current = true;
      setShowStatic(false);
    }
  }, [yjsConnectionStatus, isSynced]);

  return (
    <TransclusionLookupProvider>
      <PageEmbedLookupProvider>
        <PageEmbedAncestryProvider hostPageId={pageId}>
      {showStatic ? (
        <div style={{ position: "relative" }}>
          {/* Surface the pre-sync read-only window so edits typed before the
              collab provider connects aren't silently swallowed (#218). Shown
              only when the user is otherwise allowed to edit. */}
          {editable && currentPageEditMode === PageEditMode.Edit && (
            <div
              role="status"
              aria-live="polite"
              className="print-hide"
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
          )}
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
        <div className="editor-container" style={{ position: "relative" }}>
          <div ref={menuContainerRef}>
            <EditorContent editor={editor} />

            {editor && (
              <SearchAndReplaceDialog editor={editor} editable={editable} />
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
            {editor &&
              !editorIsEditable &&
              (editable || canComment) &&
              providersRef.current && <ReadonlyBubbleMenu editor={editor} />}
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
        </PageEmbedAncestryProvider>
      </PageEmbedLookupProvider>
    </TransclusionLookupProvider>
  );
}
