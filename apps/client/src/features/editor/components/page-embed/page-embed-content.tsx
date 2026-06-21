import { EditorProvider } from "@tiptap/react";
import { useMemo } from "react";
import { mainExtensions } from "@/features/editor/extensions/extensions";
import { UniqueID } from "@docmost/editor-ext";

type Props = {
  content: unknown;
};

/**
 * Read-only nested renderer for embedded whole-page content. Same pattern as
 * the transclusion read-only renderer: drop uniqueID/globalDragHandle, never
 * write back, and isolate pointer/drag events from the host editor. Nested
 * `pageEmbed`/`transclusionReference` nodes inside the content render with
 * their own views (the cycle/depth guard lives in the node view itself).
 */
export default function PageEmbedContent({ content }: Props) {
  const extensions = useMemo(() => {
    const filtered = mainExtensions.filter(
      (e: any) => e.name !== "uniqueID" && e.name !== "globalDragHandle",
    );
    return [
      ...filtered,
      UniqueID.configure({
        types: ["heading", "paragraph", "transclusionSource"],
        updateDocument: false,
      }),
    ];
  }, []);

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      onMouseDown={stop}
      onClick={stop}
      onDragStart={stop}
      onDragOver={stop}
      onDrop={stop}
    >
      <EditorProvider
        editable={false}
        immediatelyRender={true}
        extensions={extensions}
        content={content as any}
      />
    </div>
  );
}
