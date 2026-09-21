/**
 * Unit tests for the in-process SVG -> PNG rasterizer (Phase A of #585).
 *
 * These exercise the REAL worker path (resvg wasm in a worker thread) plus, for
 * the ink hard-gate, a direct resvg render so we can inspect raw RGBA pixels
 * and prove the vendored Cyrillic font actually draws — the single most
 * important guarantee of this module.
 */
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import {
  rasterizeSvgToPng,
  shutdownRasterizer,
} from './rasterize';
import { loadFontBuffer, loadWasmBytes } from './rasterize.assets';
import {
  RASTER_DEFAULT_FONT_FAMILY,
  RASTER_MAX_LONGEST_SIDE_PX,
  RASTER_MAX_SVG_BYTES,
} from './rasterize.constants';

// pngjs is present transitively; required (not imported) to avoid needing its
// type declarations under the strict tsconfig.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PNG } = require('pngjs');

const CYRILLIC_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="120">',
  '<rect width="100%" height="100%" fill="#ffffff"/>',
  '<text x="20" y="70" font-family="Helvetica, Arial, sans-serif" ',
  'font-size="44" fill="#000000">Привет, схема</text>',
  '</svg>',
].join('');

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

function hasPngSignature(buf: Buffer): boolean {
  return PNG_SIGNATURE.every((b, i) => buf[i] === b);
}

/**
 * Decode a PNG buffer and count "ink" pixels (opaque and clearly darker than a
 * white background) within a bounding box. Used to assert real rendered text.
 */
function countInkInRegion(
  png: Buffer,
  box: { x0: number; y0: number; x1: number; y1: number },
): number {
  const img = PNG.sync.read(png);
  let ink = 0;
  for (let y = box.y0; y < Math.min(box.y1, img.height); y++) {
    for (let x = box.x0; x < Math.min(box.x1, img.width); x++) {
      const idx = (img.width * y + x) << 2;
      const r = img.data[idx];
      const a = img.data[idx + 3];
      if (a > 200 && r < 128) ink++;
    }
  }
  return ink;
}

// One-shot main-thread wasm init, used only by the negative-control render.
let mainWasmReady: Promise<void> | null = null;
function ensureMainWasm(): Promise<void> {
  if (!mainWasmReady) {
    mainWasmReady = WebAssembly.compile(new Uint8Array(loadWasmBytes())).then((m) =>
      initWasm(m),
    );
  }
  return mainWasmReady;
}

/** Direct resvg render -> count dark RGBA pixels over the whole image. */
function directDarkPixels(fontBuffers: Uint8Array[]): number {
  const resvg = new Resvg(CYRILLIC_SVG, {
    font: {
      fontBuffers,
      defaultFontFamily: RASTER_DEFAULT_FONT_FAMILY,
      sansSerifFamily: RASTER_DEFAULT_FONT_FAMILY,
    },
  });
  const image = resvg.render();
  const px = image.pixels;
  let dark = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] > 10 && px[i] < 200) dark++;
  }
  image.free();
  resvg.free();
  return dark;
}

beforeAll(async () => {
  // Warm the worker so per-job timeouts later measure render time, not init.
  await rasterizeSvgToPng(CYRILLIC_SVG);
}, 30000);

afterAll(async () => {
  await shutdownRasterizer();
});

describe('rasterizeSvgToPng', () => {
  it('rasterizes a Cyrillic schematic SVG to a PNG within the size ceiling', async () => {
    const { png, width, height } = await rasterizeSvgToPng(CYRILLIC_SVG);
    expect(hasPngSignature(png)).toBe(true);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(RASTER_MAX_LONGEST_SIDE_PX);
    expect(height).toBeLessThanOrEqual(RASTER_MAX_LONGEST_SIDE_PX);
  }, 30000);

  it('[HARD GATE] actually draws the Cyrillic label (rendered ink), and the font is what makes it appear', async () => {
    // End-to-end: the worker's PNG output contains real ink in the text band.
    const { png } = await rasterizeSvgToPng(CYRILLIC_SVG);
    const ink = countInkInRegion(png, { x0: 10, y0: 20, x1: 410, y1: 95 });
    expect(ink).toBeGreaterThan(300);

    // Discriminator: prove the ink comes from the embedded font + family.
    await ensureMainWasm();
    const withFont = directDarkPixels([new Uint8Array(loadFontBuffer())]);
    const withoutFont = directDarkPixels([]); // no fonts loaded => no glyphs
    expect(withFont).toBeGreaterThan(300);
    // Without any font buffer the label cannot render, so far less ink.
    expect(withoutFont).toBeLessThan(50);
    expect(withFont).toBeGreaterThan(withoutFont * 5);
  }, 30000);

  it('scales an oversized SVG down to the longest-side ceiling', async () => {
    const big = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="1000">',
      '<rect width="100%" height="100%" fill="#ffffff"/>',
      '<rect x="100" y="100" width="500" height="500" fill="#3366cc"/>',
      '</svg>',
    ].join('');
    const { width, height } = await rasterizeSvgToPng(big);
    expect(width).toBeLessThanOrEqual(RASTER_MAX_LONGEST_SIDE_PX);
    expect(height).toBeLessThanOrEqual(RASTER_MAX_LONGEST_SIDE_PX);
    // It actually shrank from the intrinsic 4000px width.
    expect(width).toBeLessThan(4000);
  }, 30000);

  it('clamps a per-call maxLongestSidePx that exceeds the hard ceiling (F1)', async () => {
    const big = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="1000">',
      '<rect width="100%" height="100%" fill="#ffffff"/>',
      '<rect x="100" y="100" width="500" height="500" fill="#3366cc"/>',
      '</svg>',
    ].join('');
    // A caller asking for a huge longest side must NOT bypass the memory cap:
    // the override may only lower RASTER_MAX_LONGEST_SIDE_PX, never raise it.
    const { width, height } = await rasterizeSvgToPng(big, {
      maxLongestSidePx: 1_000_000,
    });
    expect(width).toBeLessThanOrEqual(RASTER_MAX_LONGEST_SIDE_PX);
    expect(height).toBeLessThanOrEqual(RASTER_MAX_LONGEST_SIDE_PX);
  }, 30000);

  it('rejects a malformed SVG', async () => {
    await expect(rasterizeSvgToPng('this is not an svg <<<')).rejects.toThrow();
  }, 30000);

  it('rejects an SVG larger than RASTER_MAX_SVG_BYTES before rendering', async () => {
    const huge =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      ' '.repeat(RASTER_MAX_SVG_BYTES + 100) +
      '</svg>';
    await expect(rasterizeSvgToPng(huge)).rejects.toThrow(/too large/i);
  }, 30000);

  it('times out on a pathological SVG, kills the worker, and recovers on the next call', async () => {
    const prev = process.env.RASTER_TIMEOUT_MS;
    process.env.RASTER_TIMEOUT_MS = '300';
    try {
      // A full-canvas heavy Gaussian blur renders for well over 300ms.
      const rects = Array.from(
        { length: 300 },
        (_, i) =>
          `<rect x="${(i * 5) % 1500}" y="${(i * 7) % 1500}" width="400" height="400" fill="#123456"/>`,
      ).join('');
      const pathological = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1600">',
        '<filter id="b" x="-50%" y="-50%" width="200%" height="200%">',
        '<feGaussianBlur stdDeviation="200"/></filter>',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        `<g filter="url(#b)">${rects}</g>`,
        '</svg>',
      ].join('');

      await expect(rasterizeSvgToPng(pathological)).rejects.toThrow(
        /timed out/i,
      );
    } finally {
      process.env.RASTER_TIMEOUT_MS = prev;
    }

    // The worker was terminated; the next call must transparently recreate it.
    const { png } = await rasterizeSvgToPng(CYRILLIC_SVG);
    expect(hasPngSignature(png)).toBe(true);
  }, 30000);
});
