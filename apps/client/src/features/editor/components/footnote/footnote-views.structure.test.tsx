import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

/**
 * Structural regression guard for #146 (PR #147).
 *
 * The caret/click-offset fix rests entirely on ONE invariant: in every editable
 * footnote NodeView the editable `NodeViewContent` (contentDOM) must be the
 * FIRST child of the wrapper, with no non-editable (`contenteditable="false"`)
 * element before it. If a future edit reinserts chrome (separator, heading,
 * marker, back-link) ahead of the content, the macOS hit-testing bug returns
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

import FootnotesListView from "./footnotes-list-view";
import FootnoteDefinitionView from "./footnote-definition-view";

// Minimal NodeViewProps stub: definition view only touches node.attrs.id and
// editor.state (the latter unused once getFootnoteNumber is mocked).
const props = {
  node: { attrs: { id: "fn-1" }, textContent: "" },
  editor: { state: {}, isEditable: true, commands: {} },
  getPos: () => 0,
  updateAttributes: () => {},
  deleteNode: () => {},
} as any;

const cases: Array<{ name: string; ui: React.ReactElement }> = [
  { name: "FootnotesListView", ui: <FootnotesListView {...props} /> },
  { name: "FootnoteDefinitionView", ui: <FootnoteDefinitionView {...props} /> },
];

describe("#146 footnote NodeView DOM-order invariant", () => {
  it.each(cases)(
    "$name renders contentDOM as the first child",
    ({ ui }) => {
      const { getByTestId } = render(ui);
      const wrapper = getByTestId("nvw");

      const firstEl = wrapper.firstElementChild;
      expect(firstEl).not.toBeNull();
      // The editable content must be physically first.
      expect(firstEl?.hasAttribute("data-node-view-content")).toBe(true);
    },
  );

  it.each(cases)(
    "$name has no contentEditable=false chrome BEFORE the content",
    ({ ui }) => {
      const { getByTestId } = render(ui);
      const wrapper = getByTestId("nvw");

      const content = wrapper.querySelector("[data-node-view-content]")!;
      const nonEditable = wrapper.querySelectorAll('[contenteditable="false"]');
      expect(nonEditable.length).toBeGreaterThan(0); // chrome exists...

      for (const el of Array.from(nonEditable)) {
        // ...but every non-editable element must come AFTER the content node.
        const pos = content.compareDocumentPosition(el);
        expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    },
  );
});
