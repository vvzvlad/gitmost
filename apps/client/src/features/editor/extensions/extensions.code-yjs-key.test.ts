import { describe, it, expect, vi } from "vitest";
import { getSchema } from "@tiptap/core";

// `mainExtensions` reaches the app entry through its node views
// (extensions -> subpages-view -> page-query -> main.tsx), whose module scope calls
// `ReactDOM.createRoot(document.getElementById("root"))` and throws in jsdom, where
// there is no #root. Same stub as page-editor.local-first.test.tsx: it only supplies
// the `queryClient` that module exports. Nothing here renders.
vi.mock("@/main.tsx", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient() };
});

import { mainExtensions } from "./extensions";

// #515 — the Yjs KEY invariant of the inline `code` mark, pinned on the schema the
// CLIENT ACTUALLY WRITES WITH.
//
// `packages/prosemirror-markdown/test/schema-code-excludes-parity.test.ts` already
// pins this property on the canonical `Code` mark (`@docmost/editor-ext`) and on the
// vendored markdown mirror — but NEITHER of those is the schema that reaches Yjs.
// The editor persists through `mainExtensions`, which RE-EXTENDS the shared mark
// (`Code.configure({...}).extend({ addInputRules, addKeyboardShortcuts })`), and
// `extend()` can override `excludes` just as easily as it adds an input rule. An
// `excludes: ""` slipped back into THAT object would restore the hashed Yjs key on
// every keystroke while every existing parity test stayed green. This spec is the
// assertion that reds instead.
//
// y-prosemirror picks the Yjs text-attribute key with exactly this predicate
// (`marksToAttributes`, y-prosemirror 1.3.7):
//
//   const isOverlapping = !mark.type.excludes(mark.type);
//   pattrs[isOverlapping ? `${name}--${hashOfJSON(mark.toJSON())}` : name] = mark.attrs;
//
// A mark that does not exclude ITSELF is treated as "may appear several times on one
// text run with different attrs" (the way `comment` does) and is keyed by a HASH.
// `code` carries no attrs, so the hash buys nothing and costs a SECOND persistence
// canon — the same logical mark under a different key than in the full-page importer
// and than in every pre-existing document.
describe("#515 client `code` mark: the Yjs key canon (mainExtensions — the real write path)", () => {
  const schema = getSchema(mainExtensions as any);
  const code = schema.marks.code;

  it("excludes ITSELF, so y-prosemirror keys it plainly (`code`, not `code--<hash>`)", () => {
    expect(code.excludes(code)).toBe(true);
  });

  it("excludes NO other mark (#515: inline code carries bold / italic / …)", () => {
    // The #515 property itself, stated as behavior rather than as the literal
    // `excludes` string: overriding Tiptap's stock `"_"` is worth nothing if the
    // re-extended client mark evicts its neighbours anyway.
    const evicted = Object.values(schema.marks)
      .filter((markType: any) => markType.name !== "code")
      .filter((markType: any) => code.excludes(markType))
      .map((markType: any) => markType.name);
    expect(evicted).toEqual([]);
  });
});
