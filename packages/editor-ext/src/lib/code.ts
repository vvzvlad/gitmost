import { Code as TiptapCode } from "@tiptap/extension-code";

// Canonical inline `code` mark for Docmost (issue #515). Tiptap's upstream Code
// mark ships `excludes: "_"`, which makes ProseMirror strip every co-occurring
// inline mark on the HTML -> PM parse (`generateJSON`) and on editor
// transactions. That is why bold/italic/etc. around inline code were lost or
// "slid" onto separators on Markdown import (CommonMark keeps `**` around a
// `` `code` `` span as `<strong><code>…</code></strong>`). Override `excludes`
// so `code` combines with ALL other inline marks, matching CommonMark.
//
// The value is `"code"` — i.e. code excludes ONLY ITSELF, which is exactly
// ProseMirror's DEFAULT policy for a mark. It is deliberately NOT `""` ("exclude
// nothing, not even myself"): y-prosemirror keys a Yjs text attribute by the mark
// name only for marks that exclude themselves, and falls back to a HASHED key
// (`code--<base64 sha256 of the mark JSON>`) for any mark that does not — its
// signal for "this mark may appear MULTIPLE times on one text run with different
// attrs", the way a `comment` mark does. `code` carries no attrs at all, so the
// hash buys nothing and costs a second persistence canon: the same logical mark
// stored under a different Yjs key than in every pre-existing document (and than
// every other Docmost mark). Self-exclusion is a semantic no-op here — ProseMirror
// already de-dups identical marks in a set — so `"code"` keeps the #515 behavior
// (code + bold/italic coexist) with the stock Yjs representation.
//
// This is the single source of the excludes policy for the three app schemas
// (client `mainExtensions`, server `tiptapExtensions`, comment editor). The
// vendored markdown-converter mirror (`docmost-schema.ts`) deliberately does NOT
// import this at runtime (it must stay framework-free), so it sets the same
// `excludes: "code"` locally; a parity test guards the two against drift.
export const Code = TiptapCode.extend({ excludes: "code" });
