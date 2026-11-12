import { FC, useEffect, useRef } from "react";
import { Editor } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { useAtomValue } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { dictationAvailabilityAtom } from "@/features/editor/atoms/editor-atoms.ts";
import { MicButton } from "@/features/dictation/components/mic-button";

interface Props {
  editor: Editor;
  color?: string;
  iconSize?: number;
}

export const DictationGroup: FC<Props> = ({ editor, color, iconSize }) => {
  // Streaming (silence-cut) dictation is opt-in per workspace; absent/false
  // keeps the stable batch path.
  const workspace = useAtomValue(workspaceAtom);
  const streamingDictation =
    workspace?.settings?.ai?.dictationStreaming === true;
  // Cause-specific reason the mic is unavailable (published by the page editor).
  const dictationAvailability = useAtomValue(dictationAvailabilityAtom);
  // Caret snapshot taken when dictation starts (where the first segment lands).
  const rangeRef = useRef<{ from: number; to: number } | null>(null);
  // Running insertion point: after each inserted segment we remember the caret
  // end so the NEXT segment appends right after it, contiguously, regardless of
  // where the user's caret currently is. Null until the first segment lands.
  const insertPosRef = useRef<number | null>(null);

  // Keep both positions on the same spot of the text while the user edits the
  // page: a retried transcription can land minutes after the snapshot. Changes
  // applied from Yjs (a collaborator, undo/redo) are skipped: y-tiptap applies
  // them as one replacement of the whole document, whose mapping would move
  // every position to the end of the page.
  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged || transaction.getMeta(ySyncPluginKey)) {
        return;
      }
      const map = (pos: number) => transaction.mapping.map(pos);
      if (rangeRef.current) {
        rangeRef.current = {
          from: map(rangeRef.current.from),
          to: map(rangeRef.current.to),
        };
      }
      if (insertPosRef.current !== null) {
        insertPosRef.current = map(insertPosRef.current);
      }
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  const handleStart = () => {
    const { from, to } = editor.state.selection;
    rangeRef.current = { from, to };
    // New session: forget any insertion point from a previous dictation so the
    // first segment uses the fresh snapshot above.
    insertPosRef.current = null;
  };

  const handleText = (text: string) => {
    // The editor may be gone by the time async transcription returns; bail out
    // instead of operating on a destroyed instance.
    if (!editor || editor.isDestroyed) return;
    // The document may have shrunk during transcription (e.g. a collaborative
    // edit), so clamp any position into the current bounds before inserting.
    const docSize = editor.state.doc.content.size;
    const clamp = (p: number) => Math.max(0, Math.min(p, docSize));
    // First segment lands at the snapshotted caret range; subsequent segments
    // land at a zero-length range at the running insertion point so they stay
    // contiguous even if the user clicked elsewhere mid-dictation.
    const snapshot = rangeRef.current;
    const range =
      insertPosRef.current !== null
        ? { from: clamp(insertPosRef.current), to: clamp(insertPosRef.current) }
        : snapshot
          ? { from: clamp(snapshot.from), to: clamp(snapshot.to) }
          : null;
    try {
      if (range) {
        // Insert at the resolved range; a trailing space keeps words separated
        // (the hook already trims the transcribed text).
        editor.chain().focus().insertContentAt(range, `${text} `).run();
      } else {
        // No snapshot and no running point (shouldn't happen normally) — fall
        // back to the current caret.
        editor.chain().focus().insertContent(`${text} `).run();
      }
      // Remember where the inserted text ends so the next segment appends right
      // after it, independent of later user caret moves.
      insertPosRef.current = editor.state.selection.to;
    } catch {
      // The range drifted out of bounds; fall back to the current caret.
      try {
        editor.chain().focus().insertContent(`${text} `).run();
        insertPosRef.current = editor.state.selection.to;
      } catch {
        // The editor may have been destroyed; ignore so a dead editor can't
        // surface an uncaught error.
      }
    }
  };

  return (
    <MicButton
      size="md"
      streaming={streamingDictation}
      onStart={handleStart}
      onText={handleText}
      disabled={!dictationAvailability.isEditable}
      unavailableReason={dictationAvailability.reason ?? undefined}
      color={color}
      iconSize={iconSize}
      hotkey="mod+shift+D"
      // Start only from the page body: pressed in a comment, the AI chat or the
      // title, the text would still land in the body at its last selection.
      hotkeyGuard={(event) =>
        !editor.isDestroyed &&
        event.target instanceof Node &&
        editor.view.dom.contains(event.target)
      }
    />
  );
};
