import { describe, it, expect } from "vitest";
import StarterKit from "@tiptap/starter-kit";
import { addUniqueIdsToDoc } from "./unique-id.util";
import { UniqueID } from "./unique-id";

// Minimal extension set: StarterKit (paragraph/heading) + the UniqueID config
// the server uses for the addressing anchors.
const extensions = [
  StarterKit,
  UniqueID.configure({ types: ["heading", "paragraph"] }),
];

const para = (id: string | undefined, text: string) => ({
  type: "paragraph",
  ...(id !== undefined ? { attrs: { id } } : {}),
  content: [{ type: "text", text }],
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
});
