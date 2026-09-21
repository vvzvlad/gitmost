/**
 * Standalone packaging smoke test — runs the REAL dist artifacts.
 *
 * Purpose: the #585 merge gate is "in the built Docker image the wasm and the
 * font are present and an in-container render produces a PNG with non-empty
 * text". This script is the in-container check. Build the server, then run:
 *
 *   node dist/integrations/ai/rasterize/smoke.js
 *
 * It (1) exercises the public worker path to confirm a valid PNG is produced,
 * and (2) renders the same Cyrillic SVG with resvg directly to inspect raw
 * pixels and confirm the embedded font actually drew ink (dependency-free — no
 * PNG decoder needed). Exits non-zero on any failure.
 */
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { loadFontBuffer, loadWasmBytes } from './rasterize.assets';
import { RASTER_DEFAULT_FONT_FAMILY } from './rasterize.constants';
import { rasterizeSvgToPng, shutdownRasterizer } from './rasterize';

const SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="120">',
  '<rect width="100%" height="100%" fill="#ffffff"/>',
  '<text x="20" y="70" font-family="Helvetica, Arial, sans-serif" ',
  'font-size="44" fill="#000000">Привет, схема</text>',
  '</svg>',
].join('');

function isPng(buf: Buffer): boolean {
  return (
    buf.length > 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  );
}

async function main(): Promise<void> {
  // (1) Public worker path -> valid PNG.
  const { png, width, height } = await rasterizeSvgToPng(SVG);
  if (!isPng(png)) throw new Error('smoke: output is not a PNG');

  // (2) Direct resvg render -> count text ink from raw RGBA pixels.
  await initWasm(await WebAssembly.compile(new Uint8Array(loadWasmBytes())));
  const resvg = new Resvg(SVG, {
    font: {
      fontBuffers: [new Uint8Array(loadFontBuffer())],
      defaultFontFamily: RASTER_DEFAULT_FONT_FAMILY,
      sansSerifFamily: RASTER_DEFAULT_FONT_FAMILY,
    },
  });
  const image = resvg.render();
  const px = image.pixels;
  let darkPixels = 0;
  for (let i = 0; i < px.length; i += 4) {
    // Opaque and clearly darker than the white background => text ink.
    if (px[i + 3] > 10 && px[i] < 200) darkPixels++;
  }
  image.free();
  resvg.free();

  if (darkPixels < 200) {
    throw new Error(`smoke: text ink too low (${darkPixels} dark pixels)`);
  }

  // eslint-disable-next-line no-console
  console.log(
    `smoke OK: png=${png.length}B ${width}x${height}, darkPixels=${darkPixels}`,
  );
  await shutdownRasterizer();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('smoke FAILED:', err);
  process.exit(1);
});
