import { useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { htmlToMarkdown } from "@docmost/editor-ext";
import {
  pageEditorAtom,
  titleEditorAtom,
} from "@/features/editor/atoms/editor-atoms.ts";
import {
  updatePageData,
  useUpdateTitlePageMutation,
} from "@/features/page/queries/page-query.ts";
import { generatePageTitle } from "@/features/ai-chat/services/ai-chat-service.ts";
import { useQueryEmit } from "@/features/websocket/use-query-emit.ts";
import { UpdateEvent } from "@/features/websocket/types";
import localEmitter from "@/lib/local-emitter.ts";

// Maximum length we send to the model. The server truncates again; this is a
// cheap client-side bound so we never ship a huge body over the wire.
const MAX_CONTENT_CHARS = 20000;

/**
 * Generate a title for the given page from the LIVE editor content (#199),
 * including unsaved edits, then apply it IMMEDIATELY (per product decision). The
 * server endpoint only summarizes the supplied markdown — it never writes the
 * page; the actual title write goes through the existing /pages/update mutation
 * (which enforces edit permission), and is mirrored to the title field + other
 * clients exactly like TitleEditor.saveTitle. Returns a mutation-like API so the
 * button can show a loading state via `isPending`.
 */
export function useGeneratePageTitle(pageId: string) {
  const { t } = useTranslation();
  const pageEditor = useAtomValue(pageEditorAtom);
  const titleEditor = useAtomValue(titleEditorAtom);
  const { mutateAsync: updateTitle } = useUpdateTitlePageMutation();
  const emit = useQueryEmit();

  // The page/title editors come from GLOBAL atoms that re-point when the user
  // navigates to another page. The mutation below awaits the model for 1-3s, and
  // its closure captures the editors from the render that started it. Keep a live
  // reference so the post-generation write targets whatever page is on screen
  // *now*, not the page the generation was started from.
  const editorsRef = useRef({ pageEditor, titleEditor });
  editorsRef.current = { pageEditor, titleEditor };

  return useMutation<void, Error, void>({
    mutationFn: async () => {
      if (!pageEditor || pageEditor.isDestroyed) return;

      const markdown = htmlToMarkdown(pageEditor.getHTML()).trim();
      if (!markdown) {
        notifications.show({ message: t("The note is empty"), color: "yellow" });
        return;
      }

      const title = (
        await generatePageTitle(markdown.slice(0, MAX_CONTENT_CHARS))
      ).trim();
      if (!title) {
        // The model returned nothing usable — keep the existing title untouched.
        notifications.show({
          message: t("Could not generate a title"),
          color: "yellow",
        });
        return;
      }

      const page = await updateTitle({ pageId, title }); // POST /pages/update
      updatePageData(page); // refresh the react-query cache

      // Reflect the new title in the field immediately. The button lives in the
      // byline, so the title editor is not focused — setContent is safe and stays
      // undoable through its History extension (Ctrl/Cmd+Z reverts the change).
      //
      // Guard against navigation during generation: if the user switched pages
      // while the model ran, the (persistent) title editor now shows ANOTHER
      // page, so writing here would drop page A's title into page B's visible
      // field. page-editor.tsx stamps the live page editor with its pageId
      // (`editor.storage.pageId`), mirroring TitleEditor's `activePageId !==
      // pageId` guard — bail the visible write unless that live editor still
      // belongs to the page this title was generated for. The DB write above is
      // already correct (keyed by the captured `pageId`), and the broadcast below
      // still propagates page A's change to other clients.
      const livePageEditor = editorsRef.current.pageEditor;
      const liveTitleEditor = editorsRef.current.titleEditor;
      // `storage.pageId` is stamped untyped in page-editor.tsx's onCreate.
      const livePageId = (livePageEditor?.storage as { pageId?: string })
        ?.pageId;
      const stillOnPage = livePageId === pageId;
      if (
        stillOnPage &&
        liveTitleEditor &&
        !liveTitleEditor.isDestroyed &&
        !liveTitleEditor.isFocused
      ) {
        liveTitleEditor.commands.setContent(page.title);
      }

      // Broadcast to other clients, mirroring TitleEditor.saveTitle's event shape.
      const event: UpdateEvent = {
        operation: "updateOne",
        spaceId: page.spaceId,
        entity: ["pages"],
        id: page.id,
        payload: {
          title: page.title,
          slugId: page.slugId,
          parentPageId: page.parentPageId,
          icon: page.icon,
        },
      };
      localEmitter.emit("message", event);
      emit(event);

      notifications.show({ message: t("Title generated") });
    },
    onError: (err) => {
      // Map known HTTP statuses to friendly messages, falling back to generic.
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      const message =
        status === 403
          ? t("AI title generation is disabled")
          : status === 503
            ? t("AI is not configured")
            : status === 429
              ? t("Too many requests, please try again later")
              : t("Failed to generate title");
      notifications.show({ message, color: "red" });
    },
  });
}
