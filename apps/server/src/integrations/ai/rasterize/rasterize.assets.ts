/**
 * Loads the two binary assets the rasterizer needs: the resvg wasm module and
 * the vendored DejaVu Sans font. Both are cached after the first read.
 *
 * Runtime layout: this file compiles to
 *   dist/integrations/ai/rasterize/rasterize.assets.js
 * and the font `.ttf` is copied next to it by the nest-cli `assets` rule (see
 * apps/server/nest-cli.json). So the font is always resolved __dirname-relative,
 * which is `dist/integrations/ai/rasterize/` at runtime and
 * `src/integrations/ai/rasterize/` under ts-jest — the .ttf exists in both.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** File name of the vendored Cyrillic-capable font (see DejaVuSans.LICENSE.txt). */
export const RASTER_FONT_FILE = 'DejaVuSans.ttf';

let fontBuffer: Buffer | null = null;
let wasmBytes: Buffer | null = null;

/**
 * Resolve the absolute path of the resvg wasm binary.
 *
 * The package's `exports` map explicitly exposes the `./index_bg.wasm` subpath,
 * so `require.resolve` of that subpath is the preferred route. It does NOT
 * expose `./package.json`, so the documented package.json fallback would throw
 * ERR_PACKAGE_PATH_NOT_EXPORTED; instead we fall back to the `.` entry (which
 * IS exported) and derive the sibling wasm from its directory.
 */
export function resolveWasmPath(): string {
  try {
    return require.resolve('@resvg/resvg-wasm/index_bg.wasm');
  } catch {
    const mainEntry = require.resolve('@resvg/resvg-wasm');
    return path.join(path.dirname(mainEntry), 'index_bg.wasm');
  }
}

/** Read (and cache) the resvg wasm module bytes. */
export function loadWasmBytes(): Buffer {
  if (!wasmBytes) {
    wasmBytes = fs.readFileSync(resolveWasmPath());
  }
  return wasmBytes;
}

/** Read (and cache) the vendored font buffer from next to this compiled file. */
export function loadFontBuffer(): Buffer {
  if (!fontBuffer) {
    fontBuffer = fs.readFileSync(path.join(__dirname, RASTER_FONT_FILE));
  }
  return fontBuffer;
}
