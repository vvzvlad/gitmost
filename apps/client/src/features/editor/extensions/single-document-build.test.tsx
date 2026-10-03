// Tripwire for SingleDocumentBuild, which relies on @tiptap/react and
// prosemirror-view internals (see single-document-build.ts). It mounts a real
// Editor through a real EditorContent and fails if a library upgrade brings
// back the second document build or stops React node views from rendering.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Editor, Mark, Node } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import {
  EditorContent,
  MarkViewContent,
  NodeViewWrapper,
  ReactMarkViewRenderer,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import { SingleDocumentBuild } from "./single-document-build";

let nodeViewsBuilt = 0;

function BoxView() {
  return <NodeViewWrapper data-testid="react-box">React box</NodeViewWrapper>;
}

const ReactBox = Node.create({
  name: "reactBox",
  group: "block",
  atom: true,
  parseHTML: () => [{ tag: "div[data-react-box]" }],
  renderHTML: () => ["div", { "data-react-box": "" }],
  addNodeView() {
    // Same flushSync opt-in as every React node view in editor-ext.
    this.editor.isInitialized = true;
    const renderer = ReactNodeViewRenderer(BoxView);
    return (props) => {
      nodeViewsBuilt += 1;
      return renderer(props);
    };
  },
});

// A React mark view, like the Spoiler mark in mainExtensions.
const ReactSpoiler = Mark.create({
  name: "reactSpoiler",
  parseHTML: () => [{ tag: "span[data-react-spoiler]" }],
  renderHTML: () => ["span", { "data-react-spoiler": "" }, 0],
  addMarkView() {
    return ReactMarkViewRenderer(() => (
      <span data-testid="react-spoiler">
        <MarkViewContent />
      </span>
    ));
  },
});

afterEach(() => {
  cleanup();
  nodeViewsBuilt = 0;
});

describe("SingleDocumentBuild", () => {
  it("builds the document once and still renders React node views, also after a remount", () => {
    const editor = new Editor({
      extensions: [StarterKit, ReactBox, SingleDocumentBuild],
      content: "<p>before</p><div data-react-box></div><p>after</p>",
    });
    const docView = (editor.view as any).docView;

    const first = render(<EditorContent editor={editor} />);

    expect((editor.view as any).docView).toBe(docView);
    expect(nodeViewsBuilt).toBe(1);
    expect(screen.getByTestId("react-box").textContent).toBe("React box");

    // EditorContent strips the node views on unmount; a new EditorContent on
    // the same editor has to rebuild them and render them again.
    first.unmount();
    render(<EditorContent editor={editor} />);
    expect(screen.getByTestId("react-box").textContent).toBe("React box");

    editor.destroy();
  });

  it("renders React mark views without rebuilding the document", () => {
    const editor = new Editor({
      extensions: [StarterKit, ReactSpoiler, SingleDocumentBuild],
      content: "<p>a <span data-react-spoiler>hidden</span></p>",
    });
    const docView = (editor.view as any).docView;

    render(<EditorContent editor={editor} />);

    expect((editor.view as any).docView).toBe(docView);
    expect(screen.getByTestId("react-spoiler").textContent).toBe("hidden");

    editor.destroy();
  });

  it("renders every live node view created by transactions before the mount", () => {
    // The hidden live editor receives collab transactions before its
    // EditorContent mounts; enough churn to pass the pending-set prune floor.
    const editor = new Editor({
      extensions: [StarterKit, ReactBox, SingleDocumentBuild],
      content: "<p>start</p>",
    });
    for (let i = 0; i < 300; i++) {
      editor.commands.insertContentAt(0, { type: "reactBox" });
    }
    editor.commands.deleteRange({ from: 0, to: 200 });
    let live = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "reactBox") live += 1;
    });

    render(<EditorContent editor={editor} />);

    expect(live).toBe(100);
    expect(screen.getAllByTestId("react-box")).toHaveLength(live);

    editor.destroy();
  });
});
