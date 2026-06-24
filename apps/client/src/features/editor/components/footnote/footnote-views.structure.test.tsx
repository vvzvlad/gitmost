import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

/**
 * Structural regression guard for #146 (PR #147).
 *
 * Guards ALL THREE editable NodeViews touched by the fix: the two footnote views
 * (FootnotesListView, FootnoteDefinitionView) AND the code block (CodeBlockView).
 *
 * The caret/click-offset fix rests entirely on ONE invariant: in every editable
 * NodeView the editable `NodeViewContent` (contentDOM) must come FIRST in the
 * wrapper, with no non-editable (`contenteditable="false"`) element before it.
 * If a future edit reinserts chrome (separator, heading, marker, back-link,
 * language menu) ahead of the content, the macOS hit-testing bug returns
 * silently — and the symptom needs a real browser to see. This test pins the
 * DOM ORDER (the proxy that IS the fix) in the existing jsdom harness.
 *
 * We stub `@tiptap/react` so the views render as plain DOM and we can inspect
 * the child order our JSX produces — that order is exactly what regresses, and
 * it does not depend on a live editor. The stubbed `NodeViewContent` carries the
 * real `data-node-view-content` marker tiptap uses, so the assertion mirrors
 * production. This test passes on the fixed order and FAILS on the pre-fix order
 * (chrome-before-content).
 */
vi.mock("@tiptap/react", () => ({
  NodeViewWrapper: ({ children, ...props }: any) => (
    <div data-testid="nvw" {...props}>
      {children}
    </div>
  ),
  // Mirror the real contentDOM marker so the guard matches production output.
  NodeViewContent: (props: any) => <div data-node-view-content="" {...props} />,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// footnote-definition-view reads a cached number from the numbering plugin;
// stub it so we don't need a live ProseMirror state.
vi.mock("@docmost/editor-ext", () => ({
  getFootnoteNumber: () => 1,
}));

// Mocks so CodeBlockView renders cheaply (no MantineProvider, no matchMedia).
// The Group mock MUST forward contentEditable: React serializes
// contentEditable={false} to the DOM attribute contenteditable="false", which
// the structural guard selects on to identify non-editable chrome.
vi.mock("@mantine/core", () => ({
  Group: ({ children, className, contentEditable }: any) => (
    <div className={className} contentEditable={contentEditable}>
      {children}
    </div>
  ),
  Select: () => null,
  Tooltip: ({ children }: any) => <>{children}</>,
  ActionIcon: ({ children, onClick }: any) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
vi.mock("@/components/common/copy-button", () => ({
  CopyButton: ({ children }: any) => children({ copied: false, copy: () => {} }),
}));
vi.mock("@tabler/icons-react", () => ({
  IconCheck: () => null,
  IconCopy: () => null,
}));
vi.mock("@/features/editor/components/code-block/mermaid-view.tsx", () => ({
  default: () => null,
}));

import FootnotesListView from "./footnotes-list-view";
import FootnoteDefinitionView from "./footnote-definition-view";
import CodeBlockView from "../code-block/code-block-view";

// Minimal NodeViewProps stub: definition view only touches node.attrs.id and
// editor.state (the latter unused once getFootnoteNumber is mocked).
const props = {
  node: { attrs: { id: "fn-1" }, textContent: "" },
  editor: { state: {}, isEditable: true, commands: {} },
  getPos: () => 0,
  updateAttributes: () => {},
  deleteNode: () => {},
} as any;

// CodeBlockView needs more than the footnote stub: a language attr (non-mermaid
// so MermaidView never renders), an editor with selection/on/off, and an
// extension exposing lowlight.listLanguages.
const codeBlockProps = {
  node: { attrs: { language: "javascript" }, textContent: "", nodeSize: 1 },
  editor: {
    state: { selection: { from: 0, to: 0 } },
    isEditable: true,
    commands: {},
    on: vi.fn(),
    off: vi.fn(),
  },
  extension: {
    options: { lowlight: { listLanguages: () => ["javascript", "python"] } },
  },
  getPos: () => 0,
  updateAttributes: () => {},
  deleteNode: () => {},
} as any;

const cases: Array<{ name: string; ui: React.ReactElement }> = [
  { name: "FootnotesListView", ui: <FootnotesListView {...props} /> },
  { name: "FootnoteDefinitionView", ui: <FootnoteDefinitionView {...props} /> },
  { name: "CodeBlockView", ui: <CodeBlockView {...codeBlockProps} /> },
];

describe("#146 editable NodeView contentDOM-first invariant", () => {
  it.each(cases)(
    "$name renders the editable contentDOM ahead of all non-editable chrome",
    ({ ui }) => {
      const { getByTestId } = render(ui);
      const wrapper = getByTestId("nvw");

      const content = wrapper.querySelector("[data-node-view-content]");
      expect(content).not.toBeNull();

      // The contentDOM sits at the FRONT of the wrapper: it is either the
      // wrapper's first child (footnote views) or nested in the first child
      // (code-block wraps it in <pre>). Either way the first element child
      // must contain it. (compareDocumentPosition below is NOT redundant here:
      // for code-block the content is not the literal first child, so we keep
      // the document-order check to prove no chrome precedes the content.)
      const firstEl = wrapper.firstElementChild!;
      expect(firstEl === content || firstEl.contains(content!)).toBe(true);

      // Chrome exists (separator/heading/marker/back-link/menu)...
      const nonEditable = wrapper.querySelectorAll('[contenteditable="false"]');
      expect(nonEditable.length).toBeGreaterThan(0);

      // ...and every non-editable element comes AFTER the contentDOM, so the
      // browser's click hit-testing reaches the editable content first (#146).
      for (const el of Array.from(nonEditable)) {
        const pos = content!.compareDocumentPosition(el);
        expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    },
  );
});
