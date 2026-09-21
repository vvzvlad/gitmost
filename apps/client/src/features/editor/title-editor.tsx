import "@/features/editor/styles/index.css";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Document } from "@tiptap/extension-document";
import { Heading } from "@tiptap/extension-heading";
import { Text } from "@tiptap/extension-text";
import { Placeholder } from "@tiptap/extension-placeholder";
import { useAtomValue } from "jotai";
import {
  currentPageEditModeAtom,
  pageEditorAtom,
  titleEditorAtom,
} from "@/features/editor/atoms/editor-atoms";
import {
  updatePageData,
  useUpdateTitlePageMutation,
} from "@/features/page/queries/page-query";
import { useDebouncedCallback, getHotkeyHandler } from "@mantine/hooks";
import { useAtom } from "jotai";
import { useQueryEmit } from "@/features/websocket/use-query-emit.ts";
import { History } from "@tiptap/extension-history";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import EmojiCommand from "@/features/editor/extensions/emoji-command.ts";
import { UpdateEvent } from "@/features/websocket/types";
import localEmitter from "@/lib/local-emitter.ts";
import { PageEditMode } from "@/features/user/types/user.types.ts";
import { openSearchSpotlight } from "@/features/search/constants.ts";
import { platformModifierKey } from "@/lib";
import { useTitleAutofocus } from "@/features/editor/hooks/use-title-autofocus";

export interface TitleEditorProps {
  pageId: string;
  slugId: string;
  // Ф7 (#643) — may be `null` (a page with no title) when mounted from the
  // meta cache before `/pages/info` resolves.
  title: string | null;
  spaceSlug: string;
  editable: boolean;
  // Ф7 (#643) — whether the LIVE page of this pageId has resolved. `false` while
  // mounted on cached meta with `/pages/info` still in flight. Gates the two
  // operations that can erase/misroute a title from a non-authoritative value:
  // the canonicalizing navigate and the force-save-on-unmount. Flag OFF (and the
  // legacy `page && space` mount, which only renders after the live page is in
  // hand): defaults to `true`, so behavior is unchanged.
  pageResolved?: boolean;
}

export function TitleEditor({
  pageId,
  slugId,
  title,
  spaceSlug,
  editable,
  pageResolved = true,
}: TitleEditorProps) {
  const { t } = useTranslation();
  const { mutateAsync: updateTitlePageMutationAsync } =
    useUpdateTitlePageMutation();
  const pageEditor = useAtomValue(pageEditorAtom);
  const [, setTitleEditor] = useAtom(titleEditorAtom);
  const emit = useQueryEmit();
  const navigate = useNavigate();
  const [activePageId, setActivePageId] = useState(pageId);
  const currentPageEditMode = useAtomValue(currentPageEditModeAtom);
  // Ф7 (#643) — read the CURRENT resolution at unmount time (the cleanup below is
  // registered once per pageId, so it would otherwise close over the mount-time
  // value and force-save a page that only resolved after mount).
  const pageResolvedRef = useRef(pageResolved);
  pageResolvedRef.current = pageResolved;

  const titleEditor = useEditor({
    extensions: [
      Document.extend({
        content: "heading",
      }),
      Heading.configure({
        levels: [1],
      }),
      Text,
      Placeholder.configure({
        placeholder: t("Untitled"),
        showOnlyWhenEditable: false,
      }),
      History.configure({
        depth: 20,
      }),
      EmojiCommand,
    ],
    onCreate({ editor }) {
      if (editor) {
        // @ts-ignore
        setTitleEditor(editor);
        setActivePageId(pageId);
      }
    },
    onUpdate({ editor }) {
      debounceUpdate();
    },
    editable: editable,
    content: title,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        "aria-label": t("Page title"),
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
        },
      },
    },
  });

  useEffect(() => {
    // Ф7 (#643) — the canonicalizing URL rewrite must not run until the LIVE page
    // resolved. Before that, `title` is the cached/placeholder value; navigating
    // on it could rewrite the route to a non-authoritative slug (and, with a
    // route that already carries the real spaceSlug, needlessly churn). Once the
    // live title lands this re-runs and canonicalizes. Flag OFF: `pageResolved`
    // is always true, so this fires on mount + title change exactly as today.
    if (!pageResolved) return;
    const anchorId = window.location.hash
      ? window.location.hash.substring(1)
      : undefined;
    const pageSlug = buildPageUrl(spaceSlug, slugId, title ?? undefined, anchorId);
    navigate(pageSlug, { replace: true });
  }, [title, pageResolved]);

  const saveTitle = useCallback(() => {
    if (!titleEditor || activePageId !== pageId) return;

    // Ф7 (#643) — treat an UNRESOLVED title (`undefined`, e.g. mounted on cached
    // meta before `/pages/info`) exactly like `null`: an empty editor over an
    // unresolved title must BAIL, never persist `title:""` over everyone's copy
    // (the title-erasure trap). `null`/`undefined` collapse to the same guard.
    const resolvedTitle = title ?? null;
    if (
      titleEditor.getText() === resolvedTitle ||
      (titleEditor.getText() === "" && resolvedTitle === null)
    ) {
      return;
    }

    updateTitlePageMutationAsync({
      pageId: pageId,
      title: titleEditor.getText(),
    }).then((page) => {
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

      if (page.title !== titleEditor.getText()) return;

      updatePageData(page);

      localEmitter.emit("message", event);
      emit(event);
    });
  }, [pageId, title, titleEditor]);

  const debounceUpdate = useDebouncedCallback(saveTitle, 500);

  useEffect(() => {
    // Do not overwrite the title while the user is actively editing it. The
    // server rebroadcasts PAGE_UPDATED to the author too, and that echo can
    // carry a title that lags behind what the user has just typed; resetting
    // content from it here would drop in-progress characters and jump the
    // cursor. Apply external title changes only when the field is not focused.
    if (
      titleEditor &&
      !titleEditor.isDestroyed &&
      !titleEditor.isFocused &&
      title !== titleEditor.getText()
    ) {
      titleEditor.commands.setContent(title);
    }
  }, [pageId, title, titleEditor]);

  useTitleAutofocus(titleEditor, pageId, pageResolved);

  useEffect(() => {
    return () => {
      // force-save title on navigation. Ф7 (#643) — a NO-OP until the live page
      // resolved: mounted on cached meta, an unmount before `/pages/info` must
      // not persist a placeholder/cached title (the title-erasure trap). Read via
      // the ref so the decision reflects resolution AT UNMOUNT, not at mount.
      if (pageResolvedRef.current) saveTitle();
    };
  }, [pageId]);

  useEffect(() => {
    if (!titleEditor) return;
    titleEditor.setEditable(editable && currentPageEditMode === PageEditMode.Edit);
  }, [currentPageEditMode, titleEditor, editable]);

  const openSearchDialog = () => {
    const event = new CustomEvent("openFindDialogFromEditor", {});
    document.dispatchEvent(event);
  };

  function handleTitleKeyDown(event: any) {
    if (!titleEditor || !pageEditor || event.shiftKey) return;

    // Prevent focus shift when IME composition is active
    // `keyCode === 229` is added to support Safari where `isComposing` may not be reliable
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;

    const { key } = event;
    const { $head } = titleEditor.state.selection;

    if (key === "Enter") {
      event.preventDefault();

      const { $from } = titleEditor.state.selection;
      const titleText = titleEditor.getText();

      // Get the text offset within the heading node (not document position)
      const textOffset = $from.parentOffset;

      const textAfterCursor = titleText.slice(textOffset);

      // Delete text after cursor from title (this will be in undo history)
      const endPos = titleEditor.state.doc.content.size;
      if (textAfterCursor) {
        titleEditor.commands.deleteRange({ from: $from.pos, to: endPos });
      }

      // Don't add to history so undo in page editor won't remove this split
      pageEditor
        .chain()
        .command(({ tr }) => {
          tr.setMeta("addToHistory", false);
          return true;
        })
        .insertContentAt(0, {
          type: "paragraph",
          content: textAfterCursor
            ? [{ type: "text", text: textAfterCursor }]
            : undefined,
        })
        .focus("start")
        .run();
      return;
    }

    const shouldFocusEditor =
      key === "ArrowDown" || (key === "ArrowRight" && !$head.nodeAfter);

    if (shouldFocusEditor) {
      pageEditor.commands.focus("start");
    }
  }

  return (
    <div className="page-title">
      <EditorContent
        editor={titleEditor}
        onKeyDown={(event) => {
          // First handle the search hotkey
          getHotkeyHandler([["mod+F", openSearchDialog]])(event);

          // Then handle other key events
          handleTitleKeyDown(event);
        }}
      />
    </div>
  );
}
