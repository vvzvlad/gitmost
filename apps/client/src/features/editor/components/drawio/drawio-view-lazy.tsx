import { lazy, Suspense } from "react";
import { NodeViewProps } from "@tiptap/react";

// Lazily load the drawio node view so the heavy react-drawio embed runtime is
// split into its own chunk and fetched only when a drawio diagram is actually
// rendered (mirrors excalidraw-view-lazy).
const DrawioView = lazy(
  () => import("@/features/editor/components/drawio/drawio-view.tsx"),
);

export default function DrawioViewLazy(props: NodeViewProps) {
  return (
    <Suspense fallback={null}>
      <DrawioView {...props} />
    </Suspense>
  );
}
