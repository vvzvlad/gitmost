import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

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

// footnote-definition-view reads a cached number + reference count from the
// numbering plugin; stub them so we don't need a live ProseMirror state. The
// ref-count is a hoisted mutable so a test can drive the single-vs-multi
// backlink branch (#168). Default 1 = single reference (the #146 cases).
const { mockRefCount } = vi.hoisted(() => ({ mockRefCount: { value: 1 } }));
vi.mock("@docmost/editor-ext", () => ({
  getFootnoteNumber: () => 1,
  getFootnoteRefCount: () => mockRefCount.value,
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
  CopyButton: ({ children }: any) =>
    children({ copied: false, copy: () => {} }),
}));
vi.mock("@tabler/icons-react", () => ({
  IconCheck: () => null,
  IconCopy: () => null,
}));
vi.mock("@/features/editor/components/code-block/mermaid-view.tsx", () => ({
  default: () => null,
}));

import FootnotesListView from "./footnotes-list-view";
import FootnoteDefinitionView, {
  backlinkLabel,
} from "./footnote-definition-view";
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

// #168: a footnote referenced more than once shows one lettered backlink per
// occurrence (↩ a b c), each scrolling to its own reference; a single-reference
// footnote keeps the plain ↩.
describe("#168 footnote definition multi-backlinks", () => {
  afterEach(() => {
    // Reset the shared ref-count mock so other tests see a single reference.
    mockRefCount.value = 1;
  });

  const makeProps = () =>
    ({
      node: { attrs: { id: "fn-1" }, textContent: "" },
      editor: {
        state: {},
        isEditable: true,
        commands: { scrollToReference: vi.fn() },
      },
      getPos: () => 0,
      updateAttributes: () => {},
      deleteNode: () => {},
    }) as any;

  it("renders one lettered backlink per reference (a, b, c) plus the ↩ arrow", () => {
    mockRefCount.value = 3;
    const { getByTestId } = render(<FootnoteDefinitionView {...makeProps()} />);
    const wrapper = getByTestId("nvw");

    const links = wrapper.querySelectorAll('[role="button"]');
    expect(Array.from(links).map((l) => l.textContent)).toEqual([
      "a",
      "b",
      "c",
    ]);
    // The ↩ arrow is present (as decorative chrome, not a button).
    expect(wrapper.textContent).toContain("↩");
  });

  it("clicking the n-th backlink scrolls to the n-th occurrence (0-based)", () => {
    mockRefCount.value = 3;
    const props = makeProps();
    const { getByTestId } = render(<FootnoteDefinitionView {...props} />);
    const links = getByTestId("nvw").querySelectorAll('[role="button"]');

    fireEvent.click(links[1]); // "b"
    expect(props.editor.commands.scrollToReference).toHaveBeenCalledWith(
      "fn-1",
      1,
    );
  });

  it("a single-reference footnote renders just one ↩ (no letters)", () => {
    mockRefCount.value = 1;
    const props = makeProps();
    const { getByTestId } = render(<FootnoteDefinitionView {...props} />);
    const wrapper = getByTestId("nvw");

    const links = wrapper.querySelectorAll('[role="button"]');
    expect(links.length).toBe(1);
    expect(links[0].textContent).toBe("↩");

    fireEvent.click(links[0]);
    expect(props.editor.commands.scrollToReference).toHaveBeenCalledWith(
      "fn-1",
      0,
    );
  });
});

// #185 re-review pt 7: backlinkLabel is base-26 (a..z, then aa…). The component
// tests only cover a,b,c (index 0-2); pin the >= 26 carry boundary.
describe("backlinkLabel base-26 boundary (#168)", () => {
  it("maps 0->a, 25->z, 26->aa, 27->ab, 51->az, 52->ba", () => {
    expect(backlinkLabel(0)).toBe("a");
    expect(backlinkLabel(25)).toBe("z");
    expect(backlinkLabel(26)).toBe("aa");
    expect(backlinkLabel(27)).toBe("ab");
    expect(backlinkLabel(51)).toBe("az");
    expect(backlinkLabel(52)).toBe("ba");
  });
});
