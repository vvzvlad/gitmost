import { describe, it, expect } from "vitest";
import {
  embedRasterIfWithinBudget,
  isValidExcalidrawSvg,
} from "./excalidraw-raster.ts";
import {
  DRAWIO_RASTER_ATTR,
  MAX_RASTER_BYTES,
  RASTER_DATA_URI_PREFIX,
} from "../drawio/drawio-raster.ts";

// A realistic saved `.excalidraw.svg`: its caption is a REAL <text> element, so
// the vector is valid on its own (no browser-only foreignObject). The splice
// must leave the SVG body byte-intact and only add the root data-raster.
const EXCALIDRAW_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80">` +
  `<text x="0" y="10">hello</text></svg>`;

// 1x1 transparent PNG data-URI (tiny — well within budget).
const PNG_DATA_URI =
  RASTER_DATA_URI_PREFIX +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("embedRasterIfWithinBudget (#632 splice + budget)", () => {
  it("injects a data-raster into the excalidraw SVG when within budget", () => {
    const { svg, embedded, reason } = embedRasterIfWithinBudget(
      EXCALIDRAW_SVG,
      PNG_DATA_URI,
    );
    expect(embedded).toBe(true);
    expect(reason).toBeUndefined();
    // The root <svg …> now carries the data-raster with the exact png data-URI.
    expect(svg).toContain(`${DRAWIO_RASTER_ATTR}="${PNG_DATA_URI}"`);
    // The original body is untouched (the real <text> caption survives).
    expect(svg).toContain("<text x=\"0\" y=\"10\">hello</text>");
    // The attribute lands on the ROOT tag, not a nested element.
    expect(/<svg\b[^>]*\sdata-raster="/.test(svg)).toBe(true);
  });

  it("accepts a bare base64 payload (normalized to the png data-URI prefix)", () => {
    const bare = PNG_DATA_URI.slice(RASTER_DATA_URI_PREFIX.length);
    const { svg, embedded } = embedRasterIfWithinBudget(EXCALIDRAW_SVG, bare);
    expect(embedded).toBe(true);
    expect(svg).toContain(`${DRAWIO_RASTER_ATTR}="${RASTER_DATA_URI_PREFIX}`);
  });

  it("over budget -> saves WITHOUT a raster (svg unchanged, graceful degrade)", () => {
    // Base64 whose DECODED length exceeds MAX_RASTER_BYTES. 4 base64 chars = 3
    // bytes, so (MAX/3 + 1) * 4 chars decodes to just over the cap.
    const overChars = (Math.ceil(MAX_RASTER_BYTES / 3) + 1) * 4;
    const huge = RASTER_DATA_URI_PREFIX + "A".repeat(overChars);
    const { svg, embedded, reason } = embedRasterIfWithinBudget(
      EXCALIDRAW_SVG,
      huge,
    );
    expect(embedded).toBe(false);
    expect(reason).toBe("over budget");
    // Byte-identical to the input — no data-raster added.
    expect(svg).toBe(EXCALIDRAW_SVG);
    expect(svg).not.toContain(DRAWIO_RASTER_ATTR);
  });

  it("empty raster -> no raster (svg unchanged)", () => {
    const { svg, embedded, reason } = embedRasterIfWithinBudget(
      EXCALIDRAW_SVG,
      RASTER_DATA_URI_PREFIX,
    );
    expect(embedded).toBe(false);
    expect(reason).toBe("empty raster");
    expect(svg).toBe(EXCALIDRAW_SVG);
  });

  it("re-embedding replaces a prior data-raster (idempotent re-save)", () => {
    const once = embedRasterIfWithinBudget(EXCALIDRAW_SVG, PNG_DATA_URI).svg;
    const twice = embedRasterIfWithinBudget(once, PNG_DATA_URI).svg;
    // Exactly one data-raster attribute after a re-save.
    expect(twice.match(new RegExp(DRAWIO_RASTER_ATTR, "g"))?.length).toBe(1);
  });
});

describe("isValidExcalidrawSvg (#632 upload guardrail)", () => {
  it("accepts a real SVG (opens with <svg)", () => {
    expect(isValidExcalidrawSvg(EXCALIDRAW_SVG)).toBe(true);
  });

  it("accepts an SVG with an <?xml prolog and a leading BOM", () => {
    expect(isValidExcalidrawSvg(`<?xml version="1.0"?>\n${EXCALIDRAW_SVG}`)).toBe(
      true,
    );
    expect(isValidExcalidrawSvg(`\uFEFF${EXCALIDRAW_SVG}`)).toBe(true);
  });

  it("rejects a PNG data-URI / non-SVG bytes (never upload a raster under .svg)", () => {
    expect(isValidExcalidrawSvg(PNG_DATA_URI)).toBe(false);
    expect(isValidExcalidrawSvg("\x89PNG\r\n")).toBe(false);
    expect(isValidExcalidrawSvg("")).toBe(false);
    expect(isValidExcalidrawSvg("just some text")).toBe(false);
  });
});
