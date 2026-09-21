import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

// The fallback path renders the full TipTap editor; stub it so we can assert the
// safety valve fired without pulling in the editor stack.
vi.mock("@/features/comment/components/comment-editor", () => ({
  default: () => <div data-testid="comment-editor-fallback" />,
}));

// Mention rendering hits react-query; stub the page/share queries so the mention
// case renders in isolation.
vi.mock("@/features/page/queries/page-query.ts", () => ({
  usePageQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  usePageMetaQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));
vi.mock("@/features/share/queries/share-query.ts", () => ({
  useSharePageQuery: () => ({ data: undefined }),
}));

import { CommentContentView } from "./comment-content-view";

function renderView(content: string | object) {
  return render(
    <MantineProvider>
      <MemoryRouter>
        <CommentContentView content={content} />
      </MemoryRouter>
    </MantineProvider>,
  );
}

const doc = (content: any[]) => JSON.stringify({ type: "doc", content });
const para = (content: any[]) => ({ type: "paragraph", content });
const text = (t: string, marks?: any[]) => ({ type: "text", text: t, marks });

describe("CommentContentView", () => {
  it("renders paragraphs as <p> with text", () => {
    const { container } = renderView(doc([para([text("Hello world")])]));
    expect(screen.getByText("Hello world")).toBeDefined();
    expect(container.querySelector("p")).not.toBeNull();
  });

  it("reproduces the read-only CommentEditor DOM nesting for CSS parity", () => {
    const { container } = renderView(doc([para([text("x")])]));
    // outer .commentEditor > .ProseMirror (module) > .ProseMirror (global) > p
    const globalPm = container.querySelector("div.ProseMirror > p");
    expect(globalPm).not.toBeNull();
  });

  it("renders the bold mark as <strong>", () => {
    const { container } = renderView(
      doc([para([text("bold", [{ type: "bold" }])])]),
    );
    const el = container.querySelector("strong");
    expect(el?.textContent).toBe("bold");
  });

  it("renders the italic mark as <em>", () => {
    const { container } = renderView(
      doc([para([text("it", [{ type: "italic" }])])]),
    );
    expect(container.querySelector("em")?.textContent).toBe("it");
  });

  it("renders the strike mark as <s>", () => {
    const { container } = renderView(
      doc([para([text("st", [{ type: "strike" }])])]),
    );
    expect(container.querySelector("s")?.textContent).toBe("st");
  });

  it("renders the underline mark as <u> (not the editor fallback)", () => {
    const { container } = renderView(
      doc([para([text("un", [{ type: "underline" }])])]),
    );
    expect(container.querySelector("u")?.textContent).toBe("un");
    // Underline is a supported mark, so no degrade to the editor fallback.
    expect(screen.queryByTestId("comment-editor-fallback")).toBeNull();
  });

  it("renders the code mark as <code>", () => {
    const { container } = renderView(
      doc([para([text("co", [{ type: "code" }])])]),
    );
    expect(container.querySelector("code")?.textContent).toBe("co");
  });

  it("renders the link mark as an anchor with safe rel/target", () => {
    const { container } = renderView(
      doc([
        para([
          text("click", [
            { type: "link", attrs: { href: "https://example.com" } },
          ]),
        ]),
      ]),
    );
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(a?.textContent).toBe("click");
  });

  it("neutralizes a javascript: link href (stored XSS) while keeping the text", () => {
    const { container } = renderView(
      doc([
        para([
          text("click", [
            { type: "link", attrs: { href: "javascript:alert(1)" } },
          ]),
        ]),
      ]),
    );
    const a = container.querySelector("a");
    expect(a).not.toBeNull();
    // No navigable javascript: href — attribute is absent (or empty).
    expect(a?.getAttribute("href")).toBeFalsy();
    // The link text is still rendered.
    expect(a?.textContent).toBe("click");
  });

  it("neutralizes a control-char-obfuscated javascript: href", () => {
    const { container } = renderView(
      doc([
        para([
          text("x", [
            { type: "link", attrs: { href: "java\tscript:alert(1)" } },
          ]),
        ]),
      ]),
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBeFalsy();
  });

  it("neutralizes a data: link href", () => {
    const { container } = renderView(
      doc([
        para([
          text("x", [
            {
              type: "link",
              attrs: { href: "data:text/html,<script>alert(1)</script>" },
            },
          ]),
        ]),
      ]),
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBeFalsy();
  });

  it("preserves a mailto: link href (allowlisted scheme)", () => {
    const { container } = renderView(
      doc([
        para([
          text("mail", [
            { type: "link", attrs: { href: "mailto:a@b.com" } },
          ]),
        ]),
      ]),
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "mailto:a@b.com",
    );
  });

  it("preserves a relative link href (no scheme, not a script vector)", () => {
    const { container } = renderView(
      doc([
        para([
          text("rel", [{ type: "link", attrs: { href: "/some/path" } }]),
        ]),
      ]),
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/some/path",
    );
  });

  it("nests multiple marks on one text node", () => {
    const { container } = renderView(
      doc([para([text("x", [{ type: "bold" }, { type: "italic" }])])]),
    );
    // bold wraps italic (or vice versa) — both elements exist around the text.
    expect(container.querySelector("strong")).not.toBeNull();
    expect(container.querySelector("em")).not.toBeNull();
    expect(screen.getByText("x")).toBeDefined();
  });

  it("renders hardBreak as <br/>", () => {
    const { container } = renderView(
      doc([para([text("a"), { type: "hardBreak" }, text("b")])]),
    );
    expect(container.querySelector("br")).not.toBeNull();
  });

  it("renders a user mention as a styled span", () => {
    const { container } = renderView(
      doc([
        para([
          {
            type: "mention",
            attrs: { label: "Alice", entityType: "user", entityId: "u1" },
          },
        ]),
      ]),
    );
    expect(screen.getByText("@Alice")).toBeDefined();
    // No fallback to the editor.
    expect(screen.queryByTestId("comment-editor-fallback")).toBeNull();
  });

  it("renders a page mention as a link", () => {
    const { container } = renderView(
      doc([
        para([
          {
            type: "mention",
            attrs: {
              label: "Some Page",
              entityType: "page",
              slugId: "pg1",
            },
          },
        ]),
      ]),
    );
    expect(container.querySelector("a")).not.toBeNull();
    expect(screen.getByText("Some Page")).toBeDefined();
  });

  it("renders a legacy plain-text (non-JSON) string as plain text", () => {
    renderView("just a legacy string");
    expect(screen.getByText("just a legacy string")).toBeDefined();
    expect(screen.queryByTestId("comment-editor-fallback")).toBeNull();
  });

  it("falls back to CommentEditor for an unknown node type", () => {
    renderView(doc([{ type: "codeBlock", content: [text("x")] }]));
    expect(screen.getByTestId("comment-editor-fallback")).toBeDefined();
  });

  it("falls back to CommentEditor for malformed JSON", () => {
    renderView('{"type":"doc","content":[');
    expect(screen.getByTestId("comment-editor-fallback")).toBeDefined();
  });
});
