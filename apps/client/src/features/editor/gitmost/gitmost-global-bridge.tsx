import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { getDefaultStore } from "jotai";
import { WebSocketStatus } from "@hocuspocus/provider";
import { Editor } from "@tiptap/core";
import {
  pageEditorAtom,
  yjsConnectionStatusAtom,
} from "@/features/editor/atoms/editor-atoms.ts";
import {
  getSpaceById,
  getSpaces,
} from "@/features/space/services/space-service.ts";
import {
  createPage,
  getSidebarPages,
} from "@/features/page/services/page-service.ts";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import {
  GitmostBridge,
  GitmostCreatePagePayload,
  GitmostCreatePageResult,
  GitmostListPagesPayload,
  GitmostListPagesResult,
  GitmostListSpacesResult,
  gitmostDecodePayloadToFile,
  gitmostUploadFileToEditor,
} from "@/features/editor/gitmost/gitmost-recording.ts";

// How long to wait for a freshly-navigated page's editor to mount, become
// editable, and connect its Yjs provider before giving up.
const GITMOST_EDITOR_READY_TIMEOUT_MS = 20000;
const GITMOST_EDITOR_POLL_INTERVAL_MS = 120;

// Poll the (default) jotai store until the editor for `pageId` is mounted,
// editable and its Yjs provider is connected. Resolves the live editor, or null
// on timeout. Reuses pageEditorAtom + yjsConnectionStatusAtom — the same signals
// PageEditor maintains. The storage.pageId check guards against matching a stale
// editor left over from the previously-open page.
function gitmostWaitForEditor(
  pageId: string,
  timeoutMs: number,
): Promise<Editor | null> {
  const store = getDefaultStore();
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      const editor = store.get(pageEditorAtom) as Editor | null;
      const yjsStatus = store.get(yjsConnectionStatusAtom);
      // `storage.pageId` is a custom field PageEditor.onCreate sets; it is not
      // part of Tiptap's Storage type, so read it through an indexed cast.
      const editorPageId = (
        editor?.storage as unknown as Record<string, unknown> | undefined
      )?.pageId;
      const ready =
        !!editor &&
        !editor.isDestroyed &&
        editor.isEditable &&
        editorPageId === pageId &&
        yjsStatus === WebSocketStatus.Connected;
      if (ready) {
        resolve(editor);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(check, GITMOST_EDITOR_POLL_INTERVAL_MS);
    };
    check();
  });
}

// Registers the global gitmost bridge methods that work WITHOUT an open page
// (listSpaces / listPages / createPageWithRecording). Mounted once at the
// app-shell level so the react-router navigate fn and the api-client are
// available even when no page editor is mounted. insertRecording stays in
// PageEditor (tied to the live editable editor). Renders nothing.
export default function GitmostGlobalBridge() {
  const navigate = useNavigate();
  // The effect registers the bridge once; reading the latest navigate via a ref
  // avoids a stale closure if react-router hands back a new function identity.
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  useEffect(() => {
    const w = window as unknown as { gitmost?: Partial<GitmostBridge> };
    w.gitmost = w.gitmost || {};
    // Advertise the bridge version even before any page editor mounts; do not
    // clobber a value already set by an active PageEditor.
    if (typeof w.gitmost.version !== "number") w.gitmost.version = 1;

    const listSpaces = async (): Promise<GitmostListSpacesResult> => {
      try {
        const res = await getSpaces({ limit: 100 });
        const spaces = (res?.items ?? []).map((s) => ({
          id: s.id,
          name: s.name,
        }));
        // v1 returns only the first page; flag truncation so the host knows
        // more spaces exist.
        const truncated = Boolean(res?.meta?.hasNextPage);
        return { ok: true, spaces, truncated };
      } catch (err: any) {
        console.error("[gitmost] listSpaces failed", err);
        return {
          ok: false,
          error: "list-failed",
          message:
            err?.response?.data?.message ??
            err?.message ??
            "Failed to list spaces",
        };
      }
    };

    const listPages = async (
      payload: GitmostListPagesPayload,
    ): Promise<GitmostListPagesResult> => {
      try {
        const spaceId = payload?.spaceId;
        if (!spaceId) {
          return {
            ok: false,
            error: "bad-args",
            message: "spaceId is required",
          };
        }
        const res = await getSidebarPages({
          spaceId,
          pageId: payload?.parentPageId,
          limit: 100,
        });
        const pages = (res?.items ?? []).map((p) => ({
          id: p.id,
          title: p.title,
          hasChildren: Boolean(p.hasChildren),
        }));
        // v1 returns only the first page of children; flag truncation so the
        // host knows more exist.
        const truncated = Boolean(res?.meta?.hasNextPage);
        return { ok: true, pages, truncated };
      } catch (err: any) {
        console.error("[gitmost] listPages failed", err);
        return {
          ok: false,
          error: "list-failed",
          message:
            err?.response?.data?.message ??
            err?.message ??
            "Failed to list pages",
        };
      }
    };

    const createPageWithRecording = async (
      payload: GitmostCreatePagePayload,
    ): Promise<GitmostCreatePageResult> => {
      try {
        const { spaceId, parentPageId, title, base64, filename, mimeType } =
          payload || ({} as GitmostCreatePagePayload);

        if (!spaceId) {
          return {
            ok: false,
            error: "no-space",
            message: "spaceId is required",
          };
        }

        // Validate/decode the recording BEFORE creating the page so a bad
        // payload never leaves an empty junk page behind. Per the createPage
        // error contract, any decode failure collapses to "insert-failed" (the
        // real reason is kept in `message`).
        const decoded = gitmostDecodePayloadToFile({
          base64,
          filename,
          mimeType,
        });
        if ("error" in decoded) {
          return {
            ok: false,
            error: "insert-failed",
            message: decoded.error.message ?? "Invalid recording payload",
          };
        }

        // Resolve the space slug (needed for router navigation); also a
        // permission/existence probe -> no-space on failure.
        let spaceSlug: string | undefined;
        try {
          const space = await getSpaceById(spaceId);
          spaceSlug = space?.slug;
        } catch (err: any) {
          console.error("[gitmost] resolve space failed", err);
          return {
            ok: false,
            error: "no-space",
            message:
              err?.response?.data?.message ??
              err?.message ??
              "Space not found or no access",
          };
        }
        if (!spaceSlug) {
          return {
            ok: false,
            error: "no-space",
            message: "Space not found or no access",
          };
        }

        // Create the page (REST). Default title when none is provided.
        const defaultTitle = `Recording ${new Date().toLocaleString()}`;
        let page;
        try {
          // `spaceId` is accepted by the create-page endpoint but is not part of
          // the shared IPage type; cast to satisfy the createPage signature.
          page = await createPage({
            spaceId,
            parentPageId: parentPageId ?? undefined,
            title: title ?? defaultTitle,
          } as any);
        } catch (err: any) {
          console.error("[gitmost] createPage failed", err);
          return {
            ok: false,
            error: "create-failed",
            message:
              err?.response?.data?.message ??
              err?.message ??
              "Failed to create page",
          };
        }
        if (!page?.id || !page?.slugId) {
          return {
            ok: false,
            error: "create-failed",
            message: "Failed to create page",
          };
        }

        // Reset the shared Yjs status before navigating. The atom is global and
        // is NOT reset when a PageEditor unmounts, so it can still hold
        // "connected" from a previously-open page; clearing it ensures the
        // readiness gate below waits for the NEW page's provider to connect.
        getDefaultStore().set(yjsConnectionStatusAtom, "");

        // Navigate via the router (no full reload).
        navigateRef.current(buildPageUrl(spaceSlug, page.slugId, page.title));

        // Wait for the new page's editor: mounted, editable, Yjs connected.
        const editor = await gitmostWaitForEditor(
          page.id,
          GITMOST_EDITOR_READY_TIMEOUT_MS,
        );
        if (!editor) {
          return {
            ok: false,
            error: "editor-timeout",
            message: "Editor was not ready in time",
            // Return pageId so the host can still surface the created page.
            pageId: page.id,
          };
        }

        // Same insert path as insertRecording.
        const result = await gitmostUploadFileToEditor(
          editor,
          page.id,
          decoded.file,
        );
        if (!result.ok) {
          return {
            ok: false,
            error: "insert-failed",
            message: result.message ?? "Failed to insert recording",
            pageId: page.id,
          };
        }
        return { ok: true, pageId: page.id };
      } catch (err: any) {
        console.error("[gitmost] createPageWithRecording failed", err);
        return {
          ok: false,
          error: "insert-failed",
          message:
            err?.response?.data?.message ??
            err?.message ??
            "Failed to create page with recording",
        };
      }
    };

    w.gitmost.listSpaces = listSpaces;
    w.gitmost.listPages = listPages;
    w.gitmost.createPageWithRecording = createPageWithRecording;

    return () => {
      // Only remove our own registrations (defensive against a future second
      // mount having replaced them).
      if (w.gitmost) {
        if (w.gitmost.listSpaces === listSpaces) delete w.gitmost.listSpaces;
        if (w.gitmost.listPages === listPages) delete w.gitmost.listPages;
        if (w.gitmost.createPageWithRecording === createPageWithRecording) {
          delete w.gitmost.createPageWithRecording;
        }
      }
    };
  }, []);

  return null;
}
