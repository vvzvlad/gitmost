// Self-host the @ricky0123/vad-web + onnxruntime-web runtime assets under
// apps/client/public/vad/.
//
// WHY THIS EXISTS:
// Both vad-web and onnxruntime-web resolve their assets by URL *at runtime* (the
// VAD audio worklet + Silero model, and ORT's wasm/mjs backend). In vad-web
// 0.0.30 the default baseAssetPath / onnxWASMBasePath is "./" — i.e. relative to
// the current page URL — NOT a CDN. In this SPA that "./" request hits the
// client-side catch-all route and gets served index.html (text/html), so the
// onnxruntime ESM/wasm backend fails to initialize ("'text/html' is not a valid
// JavaScript MIME type"). We fix that by copying the needed runtime files into
// public/vad/ and pointing both path constants at the fixed absolute "/vad/".
//
// These copies are NOT committed (the ORT wasm is ~26 MB); this script runs
// before `dev` and `build` (see package.json) to repopulate them from
// node_modules. It is idempotent: it (re)creates the dir and overwrites.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "..", "public", "vad");

// vad-web exposes ./package.json, so derive its dist dir from there.
const vadDist = path.join(
  path.dirname(require.resolve("@ricky0123/vad-web/package.json")),
  "dist",
);

// onnxruntime-web's "exports" map does NOT expose ./package.json, so resolving
// it would throw ERR_PACKAGE_PATH_NOT_EXPORTED. It DOES export the exact asset
// subpaths we need, so resolve those files directly.
//
// ORT ships several wasm backends and which one the app bundle references depends
// on the resolver: Vite dev resolves the JSEP build (ort-wasm-simd-threaded.jsep.*)
// while the production rolldown build resolves the plain build
// (ort-wasm-simd-threaded.*). Ship BOTH variants so the runtime fetch hits a real
// file under /vad/ regardless of which the bundle picked (each .mjs proxy fetches
// its matching .wasm at init).
const ortJsepMjs = require.resolve(
  "onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs",
);
const ortJsepWasm = require.resolve(
  "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm",
);
const ortMjs = require.resolve("onnxruntime-web/ort-wasm-simd-threaded.mjs");
const ortWasm = require.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm");

// [absolute source path, output filename]
const files = [
  [path.join(vadDist, "vad.worklet.bundle.min.js"), "vad.worklet.bundle.min.js"],
  [path.join(vadDist, "silero_vad_v5.onnx"), "silero_vad_v5.onnx"],
  [ortJsepMjs, "ort-wasm-simd-threaded.jsep.mjs"],
  [ortJsepWasm, "ort-wasm-simd-threaded.jsep.wasm"],
  [ortMjs, "ort-wasm-simd-threaded.mjs"],
  [ortWasm, "ort-wasm-simd-threaded.wasm"],
];

fs.mkdirSync(outDir, { recursive: true });
for (const [src, name] of files) {
  if (!fs.existsSync(src)) {
    console.error(`[copy-vad-assets] missing source: ${src}`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(outDir, name));
  console.log(`[copy-vad-assets] ${name}`);
}
