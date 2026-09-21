import { describe, it, expect } from "vitest";
import StarterKit from "@tiptap/starter-kit";
import { addUniqueIdsToDoc } from "./unique-id.util";
import { UniqueID } from "./unique-id";
import { TransclusionSource } from "../transclusion/transclusion-source";

// Minimal extension set: StarterKit (paragraph/heading) + the UniqueID config
// the server uses for the addressing anchors.
const extensions = [
  StarterKit,
  UniqueID.configure({ types: ["heading", "paragraph"] }),
];

// `transclusionSource` is also an addressed type, but its id is a cross-reference
// KEY (a transclusionReference / the page_transclusions table resolves a source
// by it), so it lives in the NO_REASSIGN set: a missing id is filled, a colliding
// id is NOT reassigned (rewriting it would orphan its references).
const extensionsWithSource = [
  StarterKit,
  // Narrow the content expression to `paragraph+` so the schema builds from
  // StarterKit alone (the real allow-list references image/table/etc. nodes this
  // minimal harness doesn't register). The node name — what NO_REASSIGN keys on
  // — is unchanged.
  TransclusionSource.extend({ content: "paragraph+" }),
  UniqueID.configure({
    types: ["heading", "paragraph", "transclusionSource"],
  }),
];

const para = (id: string | undefined, text: string) => ({
  type: "paragraph",
  ...(id !== undefined ? { attrs: { id } } : {}),
  content: [{ type: "text", text }],
});

const source = (id: string | undefined, text: string) => ({
  type: "transclusionSource",
  ...(id !== undefined ? { attrs: { id } } : {}),
  // The schema requires at least one block child (content expression is `+`).
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const ids = (doc: any): (string | undefined)[] =>
  (doc.content ?? []).map((n: any) => n.attrs?.id);

describe("addUniqueIdsToDoc", () => {
  it("fills ids on nodes that are missing one", () => {
    const doc = { type: "doc", content: [para(undefined, "a"), para(undefined, "b")] };
    const out = addUniqueIdsToDoc(doc, extensions);
    const [a, b] = ids(out);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("deduplicates two nodes that share the same id (#206 editor-pm-7)", () => {
    // A copy/paste or bulk-JSON duplicate keeps the original id on both nodes.
    const doc = {
      type: "doc",
      content: [para("dup", "first"), para("dup", "second")],
    };
    const out = addUniqueIdsToDoc(doc, extensions);
    const [first, second] = ids(out);
    // The first occurrence keeps the id (stable anchor); the duplicate is
    // reassigned a fresh one so MCP addressing can't hit the wrong/both nodes.
    expect(first).toBe("dup");
    expect(second).toBeTruthy();
    expect(second).not.toBe("dup");
  });

  it("leaves already-unique ids untouched", () => {
    const doc = {
      type: "doc",
      content: [para("x1", "first"), para("x2", "second")],
    };
    const out = addUniqueIdsToDoc(doc, extensions);
    expect(ids(out)).toEqual(["x1", "x2"]);
  });

  it("does NOT reassign a colliding transclusionSource id — BOTH keep it (NO_REASSIGN)", () => {
    // Two sync-block sources sharing an id: rewriting either would orphan the
    // transclusionReferences / page_transclusions rows that resolve a source by
    // this key, so the dedupe MUST leave both ids intact. If the NO_REASSIGN
    // guard is removed, the second source is reassigned a fresh id and this fails.
    const doc = {
      type: "doc",
      content: [source("src", "first"), source("src", "second")],
    };
    const out = addUniqueIdsToDoc(doc, extensionsWithSource);
    const [first, second] = ids(out);
    expect(first).toBe("src");
    expect(second).toBe("src");
  });

  it("still FILLS a missing id on a transclusionSource (only reassignment is suppressed)", () => {
    // NO_REASSIGN suppresses dedupe of an EXISTING id, not filling a missing one:
    // a source with no id still needs a key its references can resolve.
    const doc = { type: "doc", content: [source(undefined, "only")] };
    const out = addUniqueIdsToDoc(doc, extensionsWithSource);
    const [id] = ids(out);
    expect(id).toBeTruthy();
  });

  it("only assigns ids to configured node types, not to others", () => {
    // `types` is ["heading","paragraph"]; a codeBlock is NOT addressed, so it
    // must come back without an id while the sibling paragraph is filled. (The
    // UniqueID attribute only exists on configured types in the schema.)
    const doc = {
      type: "doc",
      content: [
        { type: "codeBlock", content: [{ type: "text", text: "x = 1" }] },
        para(undefined, "after"),
      ],
    };
    const out = addUniqueIdsToDoc(doc, extensions);
    const [codeId, paraId] = ids(out);
    expect(codeId).toBeUndefined();
    expect(paraId).toBeTruthy();
  });

  it("assigns ids to target nodes nested inside non-target containers", () => {
    // findChildren walks the whole tree: a paragraph inside a blockquote still
    // gets an id, while the (non-target) blockquote wrapper does not.
    const doc = {
      type: "doc",
      content: [
        { type: "blockquote", content: [para(undefined, "quoted")] },
      ],
    };
    const out = addUniqueIdsToDoc(doc, extensions) as any;
    const blockquote = out.content[0];
    const nestedPara = blockquote.content[0];
    expect(blockquote.attrs?.id).toBeUndefined();
    expect(nestedPara.attrs.id).toBeTruthy();
  });

  it("is idempotent: a second pass keeps every already-unique id unchanged", () => {
    // Once ids are assigned and unique, re-running must be a fixed point — no
    // churn that would invalidate stored MCP anchors on every save.
    const doc = {
      type: "doc",
      content: [para(undefined, "a"), para(undefined, "b"), para(undefined, "c")],
    };
    const once = addUniqueIdsToDoc(doc, extensions);
    const twice = addUniqueIdsToDoc(once, extensions);
    expect(ids(twice)).toEqual(ids(once));
    // And all three are distinct, so the second pass had real ids to preserve.
    expect(new Set(ids(once)).size).toBe(3);
  });
});
