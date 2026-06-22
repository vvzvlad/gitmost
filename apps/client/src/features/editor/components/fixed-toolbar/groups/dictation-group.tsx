import { FC, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { MicButton } from "@/features/dictation/components/mic-button";

interface Props {
  editor: Editor;
  color?: string;
  iconSize?: number;
}

export const DictationGroup: FC<Props> = ({ editor, color, iconSize }) => {
  // Caret snapshot taken when dictation starts (where the first segment lands).
  const rangeRef = useRef<{ from: number; to: number } | null>(null);
  // Running insertion point: after each inserted segment we remember the caret
  // end so the NEXT segment appends right after it, contiguously, regardless of
  // where the user's caret currently is. Null until the first segment lands.
  const insertPosRef = useRef<number | null>(null);

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
      streaming
      onStart={handleStart}
      onText={handleText}
      disabled={!editor.isEditable}
      color={color}
      iconSize={iconSize}
    />
  );
};
