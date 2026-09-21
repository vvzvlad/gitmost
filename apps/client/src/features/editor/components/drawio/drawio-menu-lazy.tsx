import { lazy, Suspense } from "react";
import { EditorMenuProps } from "@/features/editor/components/table/types/types.ts";

// Lazily load the drawio bubble menu so it is split out of the editor chunk and
// fetched only when an editable editor is mounted (mirrors excalidraw-menu-lazy).
const DrawioMenu = lazy(
  () => import("@/features/editor/components/drawio/drawio-menu.tsx"),
);

export default function DrawioMenuLazy(props: EditorMenuProps) {
  return (
    <Suspense fallback={null}>
      <DrawioMenu {...props} />
    </Suspense>
  );
}
