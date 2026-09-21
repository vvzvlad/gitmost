import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the page-service so importing the module under test does not pull in the
// axios/api-client chain. `createMentionAction` is wired to `getPageById`; the
// spy lets us assert that wiring without any network. `vi.hoisted` keeps the spy
// available inside the hoisted vi.mock factory.
const { getPageById } = vi.hoisted(() => ({ getPageById: vi.fn() }));
vi.mock("@/features/page/services/page-service.ts", () => ({
  getPageById,
}));

// `uuid` v7 is used for the mention node id; pin only v7 so assertions are
// stable, keeping the rest (e.g. `validate`, used by extractPageSlugId) real.
vi.mock("uuid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("uuid")>()),
  v7: () => "fixed-mention-uuid",
}));

import {
  handleInternalLink,
  createMentionAction,
} from "./internal-link-paste";

// Minimal ProseMirror-ish EditorView fake. We record what handleInternalLink
// builds and dispatches without standing up a real schema/state.
function makeView() {
  const tr = {
    replaceWith: vi.fn(function (this: unknown) {
      return tr;
    }),
    insertText: vi.fn(function (this: unknown) {
      return tr;
    }),
    addMark: vi.fn(function (this: unknown) {
      return tr;
    }),
  };
  const schema = {
    nodes: {
      mention: {
        // Echo the attrs back so we can assert exactly what was created.
        create: vi.fn((attrs: Record<string, unknown>) => ({
          type: "mention",
          attrs,
        })),
      },
    },
    marks: {
      link: {
        create: vi.fn((attrs: Record<string, unknown>) => ({
          type: "link",
          attrs,
        })),
      },
    },
  };
  const view = {
    state: { schema, tr },
    dispatch: vi.fn(),
  };
  return { view, tr, schema };
}

describe("handleInternalLink", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing when validateFn rejects the url (no resolve, no dispatch)", async () => {
    const onResolveLink = vi.fn();
    const validateFn = vi.fn(() => false);
    const { view } = makeView();

    await handleInternalLink({ validateFn, onResolveLink })(
      "any-url",
      view as never,
      3,
      "creator-1",
    );

    expect(validateFn).toHaveBeenCalledWith("any-url", view);
    expect(onResolveLink).not.toHaveBeenCalled();
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("on resolve: inserts a mention node carrying the resolved page + anchor and dispatches replaceWith at pos", async () => {
    const page = {
      id: "page-id-99",
      title: "My Page",
      slugId: "slugABC",
    };
    const onResolveLink = vi.fn().mockResolvedValue(page);
    const { view, tr, schema } = makeView();

    // extractPageSlugId("doc-slug-xyz789") -> "xyz789" (last hyphen segment).
    await handleInternalLink({ validateFn: () => true, onResolveLink })(
      "doc-slug-xyz789",
      view as never,
      5,
      "creator-7",
      "anchor-42",
    );

    // The linked page id is the extracted slug-id, not the whole url.
    expect(onResolveLink).toHaveBeenCalledWith("xyz789", "creator-7");
    expect(schema.nodes.mention.create).toHaveBeenCalledWith({
      id: "fixed-mention-uuid",
      label: "My Page",
      entityType: "page",
      entityId: "page-id-99",
      slugId: "slugABC",
      creatorId: "creator-7",
      anchorId: "anchor-42",
    });
    expect(tr.replaceWith).toHaveBeenCalledWith(5, 5, {
      type: "mention",
      attrs: expect.objectContaining({ entityId: "page-id-99" }),
    });
    expect(tr.insertText).not.toHaveBeenCalled();
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(view.dispatch).toHaveBeenCalledWith(tr);
  });

  it("falls back to 'Untitled' label when the resolved page has no title", async () => {
    const onResolveLink = vi
      .fn()
      .mockResolvedValue({ id: "p", title: "", slugId: "s" });
    const { view, schema } = makeView();

    await handleInternalLink({ validateFn: () => true, onResolveLink })(
      "abc-id1",
      view as never,
      0,
      "c",
    );

    expect(schema.nodes.mention.create).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Untitled" }),
    );
  });

  it("on reject: inserts the raw url as plain text with a link mark and dispatches", async () => {
    const onResolveLink = vi.fn().mockRejectedValue(new Error("not found"));
    const { view, tr, schema } = makeView();

    await handleInternalLink({ validateFn: () => true, onResolveLink })(
      "http://x/page-id2",
      view as never,
      4,
      "creator-1",
    );

    // No mention node on the failure path.
    expect(schema.nodes.mention.create).not.toHaveBeenCalled();
    expect(tr.insertText).toHaveBeenCalledWith("http://x/page-id2", 4);
    expect(schema.marks.link.create).toHaveBeenCalledWith({
      href: "http://x/page-id2",
    });
    // Mark spans exactly the inserted url text: [pos, pos + url.length].
    expect(tr.addMark).toHaveBeenCalledWith(4, 4 + "http://x/page-id2".length, {
      type: "link",
      attrs: { href: "http://x/page-id2" },
    });
    expect(view.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("createMentionAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves the link via getPageById and inserts the mention", async () => {
    getPageById.mockResolvedValue({
      id: "real-page",
      title: "Real",
      slugId: "rslug",
    });
    const { view, schema } = makeView();

    await createMentionAction("ref-pageABC", view as never, 2, "creator-9");

    expect(getPageById).toHaveBeenCalledWith({ pageId: "pageABC" });
    expect(schema.nodes.mention.create).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "real-page", label: "Real" }),
    );
  });

  it("propagates a getPageById failure to the plain-link fallback", async () => {
    getPageById.mockRejectedValue(new Error("404"));
    const { view, tr } = makeView();

    await createMentionAction("ref-pageABC", view as never, 1, "creator-9");

    // Failure path: the url is inserted as text, not as a mention node.
    expect(tr.insertText).toHaveBeenCalledWith("ref-pageABC", 1);
  });
});
