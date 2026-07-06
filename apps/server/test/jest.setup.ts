// Jest global setup (runs before each test module loads).
//
// react-dom@18 (pulled in transitively via @docmost/editor-ext -> @tiptap/react
// -> react-dom, e.g. through the math node) reads `navigator` at MODULE-INIT
// time. The server jest config uses `testEnvironment: "node"`, which has no
// `navigator`, so ANY spec that transitively imports the editor schema/engine
// (e.g. the git-sync HTTP service specs, which reach the conversion engine)
// fails to LOAD with "ReferenceError: navigator is not defined". These specs
// never exercise the DOM — they just can't survive the import. Provide the
// minimal browser globals those modules touch at import so the specs run.
/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;

if (typeof g.navigator === "undefined") {
  // react-dom only reads navigator.userAgent at init; keep it minimal.
  Object.defineProperty(g, "navigator", {
    value: { userAgent: "node", platform: "node" },
    configurable: true,
    writable: true,
  });
}

if (typeof g.MessageChannel === "undefined") {
  // react-dom's scheduler references MessageChannel at init in some builds.
  g.MessageChannel = class {
    port1 = { postMessage() {}, close() {}, onmessage: null };
    port2 = { postMessage() {}, close() {}, onmessage: null };
  };
}
