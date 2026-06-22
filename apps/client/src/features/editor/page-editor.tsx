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
import { extractPageSlugId, platformModifierKey, formatBytes } from "@/lib";
import { uploadAudioAction } from "@/features/editor/components/audio/upload-audio-action.tsx";
import { getFileUploadSizeLimit } from "@/lib/config.ts";
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

interface PageEditorProps {
  pageId: string;
  editable: boolean;
  content: any;
  canComment?: boolean;
}

// --- gitmost native bridge ------------------------------------------------
// Stable JS-API on `window.gitmost` for the native host (gitmost.app /
// WKWebView) to insert a recorded audio file into the current page as an
// `audio` block, without depending on editor internals (atoms/Tiptap/Yjs).
interface GitmostInsertRecordingPayload {
  base64: string; // raw file bytes, base64 (no data: prefix)
  filename: string;
  mimeType: string; // must be an audio/* type
}

interface GitmostInsertRecordingResult {
  ok: boolean;
  attachmentId?: string;
  // Machine-readable code: "no-editor" | "bad-type" | "too-large" | "insert-failed"
  error?: string;
  message?: string; // human-readable, may be surfaced by the host
}

interface GitmostBridge {
  ready: boolean;
  version: number;
  insertRecording: (
    payload: GitmostInsertRecordingPayload,
  ) => Promise<GitmostInsertRecordingResult>;
}

// Estimate decoded byte length from a base64 string WITHOUT decoding it, so an
// oversized payload can be rejected before the buffer is allocated.
function gitmostEstimateBase64Bytes(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

// Decode a base64 string into bytes in fixed-size chunks. Call recordings can
// be tens of MB; slicing on 4-char boundaries (each slice decodes to whole
// bytes, no carry) keeps each atob() call bounded. Assumes unwrapped base64
// with no embedded whitespace (per the native-host contract). Throws
// InvalidCharacterError on malformed input.
function gitmostBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const CHUNK = 0x8000 * 4; // multiple of 4 base64 chars
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < base64.length; i += CHUNK) {
    const binary = atob(base64.slice(i, i + CHUNK));
    const bytes = new Uint8Array(binary.length);
    for (let j = 0; j < binary.length; j++) {
      bytes[j] = binary.charCodeAt(j);
    }
    parts.push(bytes);
    total += bytes.length;
  }
  // Back the result with an explicit ArrayBuffer so the view is typed
  // Uint8Array<ArrayBuffer> (not ArrayBufferLike), which `new File([...])`
  // accepts as a BlobPart under the lib.dom typings.
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
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

    const insertRecording = async (
      payload: GitmostInsertRecordingPayload,
    ): Promise<GitmostInsertRecordingResult> => {
      try {
        const { filename, mimeType } = payload || ({} as GitmostInsertRecordingPayload);
        let base64 = payload?.base64;

        // Only a live, editable editor may receive a recording.
        if (!editor || editor.isDestroyed || !editor.isEditable) {
          return { ok: false, error: "no-editor", message: "No editable page open" };
        }
        if (typeof mimeType !== "string" || !mimeType.startsWith("audio/")) {
          return { ok: false, error: "bad-type", message: "Not an audio file" };
        }
        if (typeof base64 !== "string" || base64.length === 0) {
          return { ok: false, error: "insert-failed", message: "Empty payload" };
        }

        // Defensively strip an accidental data:*;base64, prefix.
        const marker = base64.indexOf("base64,");
        if (base64.startsWith("data:") && marker !== -1) {
          base64 = base64.slice(marker + "base64,".length);
        }

        const sizeLimit = getFileUploadSizeLimit();
        // Reject oversized payloads before allocating the decode buffer.
        if (gitmostEstimateBase64Bytes(base64) > sizeLimit) {
          return {
            ok: false,
            error: "too-large",
            message: `File exceeds the ${formatBytes(sizeLimit)} attachment limit`,
          };
        }

        let bytes: Uint8Array<ArrayBuffer>;
        try {
          bytes = gitmostBase64ToBytes(base64);
        } catch (decodeErr: any) {
          return {
            ok: false,
            error: "insert-failed",
            message: decodeErr?.message ?? "Invalid base64 payload",
          };
        }

        const file = new File([bytes], filename || "recording", { type: mimeType });

        // Exact size check (the pre-decode estimate is approximate).
        if (file.size > sizeLimit) {
          return {
            ok: false,
            error: "too-large",
            message: `File exceeds the ${formatBytes(sizeLimit)} attachment limit`,
          };
        }

        // Insert at the cursor, falling back to the end of the document.
        const pos = editor.state.selection?.to ?? editor.state.doc.content.size;

        // Reuse the existing audio pipeline (placeholder -> POST /api/files/upload
        // -> replace with an `audio` node, Yjs-synced). It returns the attachment
        // on success and undefined when the upload failed (the pipeline swallows
        // the upload error and shows its own notification).
        const attachment = (await (uploadAudioAction(
          file,
          editor,
          pos,
          pageId,
        ) as unknown as Promise<{ id?: string } | undefined>));

        if (attachment?.id) {
          return { ok: true, attachmentId: attachment.id };
        }
        return { ok: false, error: "insert-failed", message: "Upload failed" };
      } catch (err: any) {
        // The bridge must never throw — surface any unexpected failure as a code.
        return {
          ok: false,
          error: "insert-failed",
          message: err?.response?.data?.message ?? err?.message ?? "Insert failed",
        };
      }
    };

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
    editor.setEditable(editable && currentPageEditMode === PageEditMode.Edit);
  }, [currentPageEditMode, editor, editable]);

  const hasConnectedOnceRef = useRef(false);
  const [showStatic, setShowStatic] = useState(true);

  useEffect(() => {
    if (
      !hasConnectedOnceRef.current &&
      yjsConnectionStatus === WebSocketStatus.Connected &&
      isSynced
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
