import { FC, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { MicButton } from "@/features/dictation/components/mic-button";

interface Props {
  editor: Editor;
  color?: string;
  iconSize?: number;
}

export const DictationGroup: FC<Props> = ({ editor, color, iconSize }) => {
  const rangeRef = useRef<{ from: number; to: number } | null>(null);

  const handleStart = () => {
    const { from, to } = editor.state.selection;
    rangeRef.current = { from, to };
  };

  const handleText = (text: string) => {
    // The editor may be gone by the time async transcription returns; bail out
    // instead of operating on a destroyed instance.
    if (!editor || editor.isDestroyed) return;
    const snapshot = rangeRef.current;
    rangeRef.current = null;
    // The document may have shrunk during transcription (e.g. a collaborative
    // edit), so clamp the snapshot into the current bounds before inserting.
    const docSize = editor.state.doc.content.size;
    const clamp = (p: number) => Math.max(0, Math.min(p, docSize));
    try {
      if (snapshot) {
        // Insert at the snapshotted caret; a trailing space keeps words
        // separated (the hook already trims the transcribed text).
        editor
          .chain()
          .focus()
          .insertContentAt(
            { from: clamp(snapshot.from), to: clamp(snapshot.to) },
            `${text} `,
          )
          .run();
      } else {
        editor.chain().focus().insertContent(`${text} `).run();
      }
    } catch {
      // The snapshot drifted out of range; fall back to the current caret.
      try {
        editor.chain().focus().insertContent(`${text} `).run();
      } catch {
        // The editor may have been destroyed; ignore so a dead editor can't
        // surface an uncaught error.
      }
    }
  };

  return (
    <MicButton
      size="md"
      onStart={handleStart}
      onText={handleText}
      disabled={!editor.isEditable}
      color={color}
      iconSize={iconSize}
    />
  );
};
