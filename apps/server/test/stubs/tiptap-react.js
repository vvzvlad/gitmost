// Jest stub for @tiptap/react.
//
// The server export/import code paths transitively import editor-ext, whose node
// extensions import from `@tiptap/react`. The real module re-exports all of
// `@tiptap/core` (headless, safe under node) AND adds React view helpers
// (`ReactNodeViewRenderer`, …) that eagerly pull in react-dom — which throws
// `navigator is not defined` under jest's node environment.
//
// So this stub DELEGATES to the real `@tiptap/core` (keeping `mergeAttributes`,
// `Node`, `Mark`, `nodeInputRule`, … working — they are used by
// `jsonToHtml`/`htmlToJson` on the server) and overrides ONLY the React view
// helpers with no-ops. Those helpers are referenced solely inside `addNodeView()`
// — code that runs only in a live browser editor, never on the server; if any
// were actually invoked here it would (correctly) surface as a test failure.
const core = require('@tiptap/core');

module.exports = {
  ...core,
  ReactNodeViewRenderer: () => () => ({}),
  NodeViewWrapper: () => null,
  NodeViewContent: () => null,
  ReactRenderer: class {},
};
