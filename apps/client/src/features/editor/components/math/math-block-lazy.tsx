import { lazy, Suspense } from "react";
import { NodeViewProps } from "@tiptap/react";

// Lazily load the KaTeX-backed block math view so the katex chunk is fetched
// only when a document actually contains a math node (mirrors the mermaid/
// excalidraw lazy pattern). The local Suspense keeps a slow katex chunk from
// crashing or blocking the whole editor: while it loads we render the raw
// LaTeX source as a node-sized placeholder.
const MathBlockView = lazy(
  () => import("@/features/editor/components/math/math-block.tsx"),
);

export default function MathBlockViewLazy(props: NodeViewProps) {
  return (
    <Suspense fallback={<div data-katex="true">{props.node.attrs.text}</div>}>
      <MathBlockView {...props} />
    </Suspense>
  );
}
