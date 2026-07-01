import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

// Covers the read-only render branch (PR #278): the language <Select> renders
// only when `editor.isEditable`; in read-only the copy button still shows.
// Mocks mirror the #146 structural harness (footnote-views.structure.test.tsx),
// except Select becomes a detectable node so we can assert its presence/absence.
vi.mock("@tiptap/react", () => ({
  NodeViewWrapper: ({ children }: any) => <div>{children}</div>,
  NodeViewContent: (props: any) => <div data-node-view-content="" {...props} />,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@mantine/core", () => ({
  Group: ({ children }: any) => <div>{children}</div>,
  Select: () => <div data-testid="language-select" />,
  Tooltip: ({ children }: any) => <>{children}</>,
  ActionIcon: ({ children, onClick }: any) => (
    <button data-testid="copy-button" onClick={onClick}>
      {children}
    </button>
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

import CodeBlockView from "./code-block-view";

const makeProps = (isEditable: boolean) =>
  ({
    node: { attrs: { language: "javascript" }, textContent: "", nodeSize: 1 },
    editor: {
      state: { selection: { from: 0, to: 0 } },
      isEditable,
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
  }) as any;

describe("CodeBlockView language selector visibility (#278)", () => {
  it("renders the language selector when the editor is editable", () => {
    const { queryByTestId } = render(<CodeBlockView {...makeProps(true)} />);
    expect(queryByTestId("language-select")).not.toBeNull();
    expect(queryByTestId("copy-button")).not.toBeNull();
  });

  it("hides the language selector in read-only but keeps the copy button", () => {
    const { queryByTestId } = render(<CodeBlockView {...makeProps(false)} />);
    expect(queryByTestId("language-select")).toBeNull();
    expect(queryByTestId("copy-button")).not.toBeNull();
  });
});
