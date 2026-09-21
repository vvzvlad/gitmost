import { MarkViewContent, MarkViewProps } from "@tiptap/react";
import { useState } from "react";

// Click-to-reveal spoiler. The revealed state is UI-only and is never written to
// the document: toggling only adds/removes the `is-revealed` class (CSS removes
// the blur). renderHTML never emits `is-revealed`, so it can't leak into the
// doc/clipboard. Works the same in editor, read-only and public-share views.
export default function SpoilerView(_props: MarkViewProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <span
      className={revealed ? "spoiler is-revealed" : "spoiler"}
      data-spoiler="true"
      onClick={() => setRevealed((v) => !v)}
    >
      <MarkViewContent />
    </span>
  );
}
