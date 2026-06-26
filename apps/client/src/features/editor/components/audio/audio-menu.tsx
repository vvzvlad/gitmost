import { BubbleMenu as BaseBubbleMenu } from "@tiptap/react/menus";
import { findParentNode, posToDOMRect, useEditorState } from "@tiptap/react";
import { useCallback, useState } from "react";
import { Node as PMNode } from "@tiptap/pm/model";
import { isEditorReady } from "@docmost/editor-ext";
import {
  EditorMenuProps,
  ShouldShowProps,
} from "@/features/editor/components/table/types/types.ts";
import { ActionIcon, Loader, Tooltip } from "@mantine/core";
import {
  IconDownload,
  IconFileText,
  IconTrash,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { getFileUrl } from "@/lib/config.ts";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { transcribeAudio } from "@/features/dictation/services/dictation-service";
import classes from "../common/toolbar-menu.module.css";

// STT-accepted audio MIME types (mirror of the server whitelist). If the
// fetched blob's type is not one of these, we infer it from the file
// extension so the upload's content-type is something the endpoint accepts.
const RECOGNIZED_AUDIO_MIME = new Set([
  "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg",
  "audio/wav", "audio/x-wav", "audio/wave", "audio/m4a", "audio/x-m4a",
]);
const AUDIO_MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4",
  wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", webm: "audio/webm",
};

export function AudioMenu({ editor }: EditorMenuProps) {
  const { t } = useTranslation();
  const workspace = useAtomValue(workspaceAtom);
  const dictationEnabled = workspace?.settings?.ai?.dictation === true;
  const [isTranscribing, setIsTranscribing] = useState(false);

  const editorState = useEditorState({
    editor,
    selector: (ctx) => {
      if (!ctx.editor) {
        return null;
      }

      const audioAttrs = ctx.editor.getAttributes("audio");

      return {
        isAudio: ctx.editor.isActive("audio"),
        src: audioAttrs?.src || null,
      };
    },
  });

  const shouldShow = useCallback(
    ({ state }: ShouldShowProps) => {
      if (!state) {
        return false;
      }

      return editor.isActive("audio") && editor.getAttributes("audio").src;
    },
    [editor],
  );

  const getReferencedVirtualElement = useCallback(() => {
    if (!isEditorReady(editor)) return;
    const { selection } = editor.state;
    const predicate = (node: PMNode) => node.type.name === "audio";
    const parent = findParentNode(predicate)(selection);

    if (parent) {
      const dom = editor.view.nodeDOM(parent?.pos) as HTMLElement;
      const domRect = dom.getBoundingClientRect();
      return {
        getBoundingClientRect: () => domRect,
        getClientRects: () => [domRect],
      };
    }

    const domRect = posToDOMRect(editor.view, selection.from, selection.to);
    return {
      getBoundingClientRect: () => domRect,
      getClientRects: () => [domRect],
    };
  }, [editor]);

  const handleTranscribe = useCallback(async () => {
    const src = editorState?.src;
    if (!src || isTranscribing) return;

    // The bubble menu shows for the selected audio node, so selection.from is
    // that node's start position. Capture it now to disambiguate duplicate-src
    // blocks after the async transcription completes.
    const selectedPos = editor.state.selection.from;

    setIsTranscribing(true);
    try {
      const fileUrl = getFileUrl(src);
      // Derive a filename from the internal src for the multipart part name and
      // for MIME inference when the fetched blob has no usable type.
      const filename = decodeURIComponent(
        src.split("?")[0].split("/").pop() || "audio",
      );

      const res = await fetch(fileUrl, { credentials: "include" });
      if (!res.ok) {
        throw new Error(`Failed to fetch audio file (HTTP ${res.status})`);
      }
      const blob = await res.blob();

      // Ensure the upload's content-type is one the STT endpoint accepts; the
      // server keys off the blob's MIME type.
      let uploadBlob = blob;
      const baseType = (blob.type || "").split(";")[0].trim().toLowerCase();
      if (!RECOGNIZED_AUDIO_MIME.has(baseType)) {
        const ext = filename.split(".").pop()?.toLowerCase() ?? "";
        const inferred = AUDIO_MIME_BY_EXT[ext];
        if (inferred) {
          // Rebuild the blob with an accepted content-type; the server keys off it.
          uploadBlob = new Blob([blob], { type: inferred });
        }
      }

      const text = (await transcribeAudio(uploadBlob, filename)).trim();
      if (text.length === 0) {
        notifications.show({ message: t("No speech detected") });
        return;
      }

      // Re-scan the doc at insert time so a collaborative edit during the async
      // transcription can't misplace the text. Among audio nodes with this src
      // (the same file may be embedded more than once), pick the occurrence
      // closest to the originally-selected block.
      let insertPos: number | null = null;
      let bestDelta = Infinity;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "audio" && node.attrs.src === src) {
          const delta = Math.abs(pos - selectedPos);
          if (delta < bestDelta) {
            bestDelta = delta;
            insertPos = pos + node.nodeSize; // position just after the audio block
          }
        }
        return true; // visit all nodes to find the closest match
      });

      const paragraph = { type: "paragraph", content: [{ type: "text", text }] };
      try {
        if (insertPos !== null) {
          editor.chain().focus().insertContentAt(insertPos, paragraph).run();
        } else {
          editor.chain().focus().insertContent(paragraph).run();
        }
      } catch (insertErr) {
        // A destroyed editor or out-of-bounds position must not throw; log and
        // ignore so the transcription itself is not reported as a failure.
        console.error("[audio-transcribe] insert failed", insertErr);
      }
    } catch (err) {
      console.error("[audio-transcribe] failed", err);
      const resp = (
        err as { response?: { status?: number; data?: { message?: string } } }
      )?.response;
      const serverMsg = resp?.data?.message;
      let message: string;
      if (serverMsg && serverMsg.trim().length > 0) {
        // The server already explains the cause (e.g. provider error, bad
        // format, STT not configured) — show it verbatim.
        message = serverMsg;
      } else if (resp?.status === 503 || resp?.status === 403) {
        message = t("Voice dictation is not configured");
      } else {
        message = `${t("Transcription failed")}: ${(err as { message?: string })?.message ?? String(err)}`;
      }
      notifications.show({ color: "red", message });
    } finally {
      setIsTranscribing(false);
    }
  }, [editor, editorState?.src, isTranscribing, t]);

  const handleDownload = useCallback(() => {
    if (!editorState?.src) return;
    const url = getFileUrl(editorState.src);
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    a.click();
  }, [editorState?.src]);

  const handleDelete = useCallback(() => {
    editor.commands.deleteSelection();
  }, [editor]);

  return (
    <BaseBubbleMenu
      editor={editor}
      pluginKey={`audio-menu`}
      updateDelay={0}
      getReferencedVirtualElement={getReferencedVirtualElement}
      options={{
        placement: "top",
        offset: 8,
        flip: false,
      }}
      shouldShow={shouldShow}
    >
      <div className={classes.toolbar}>
        {dictationEnabled && (
          <Tooltip position="top" label={isTranscribing ? t("Transcribing…") : t("Transcribe")} withinPortal={false}>
            <ActionIcon
              onClick={handleTranscribe}
              size="lg"
              aria-label={t("Transcribe")}
              variant="subtle"
              disabled={isTranscribing}
            >
              {isTranscribing ? <Loader size={18} /> : <IconFileText size={18} />}
            </ActionIcon>
          </Tooltip>
        )}

        <Tooltip position="top" label={t("Download")} withinPortal={false}>
          <ActionIcon
            onClick={handleDownload}
            size="lg"
            aria-label={t("Download")}
            variant="subtle"
          >
            <IconDownload size={18} />
          </ActionIcon>
        </Tooltip>

        <Tooltip position="top" label={t("Delete")} withinPortal={false}>
          <ActionIcon
            onClick={handleDelete}
            size="lg"
            aria-label={t("Delete")}
            variant="subtle"
          >
            <IconTrash size={18} />
          </ActionIcon>
        </Tooltip>
      </div>
    </BaseBubbleMenu>
  );
}

export default AudioMenu;
