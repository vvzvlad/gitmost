import { describe, it, expect } from "vitest";
import {
  classifyExportFormat,
  decodedBase64ByteLength,
  DRAWIO_RASTER_ATTR,
  ExportFamily,
  injectRasterIntoSvg,
  isValidDrawioSvg,
  isWithinRasterBudget,
  MAX_RASTER_BYTES,
  nextCircuitBreakerState,
  normalizeRasterDataUri,
  RASTER_CIRCUIT_BREAKER_THRESHOLD,
  RASTER_DATA_URI_PREFIX,
  RASTER_DOWNSCALE_STEPS,
  RASTER_PRIMARY_SCALE,
  resolveEffectiveUpdateSrc,
  resolveExportFamily,
  stripVolatileMxfileAttrs,
  xmlStatesMatch,
} from "./drawio-raster.ts";

// ---------------------------------------------------------------------------
// Shared fixtures — a realistic saved `.drawio.svg` whose mxgraph source lives
// ENTITY-encoded in content="&lt;mxfile…" (draw.io's native form, #507). The
// injection must leave that content= byte-intact (A4/acceptance #1).
// ---------------------------------------------------------------------------
const MXFILE_ATTR =
  'content="&lt;mxfile host=&quot;drawio&quot;&gt;&lt;diagram&gt;&lt;/diagram&gt;&lt;/mxfile&gt;"';

const DRAWIO_SVG =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" ${MXFILE_ATTR}>` +
  `<rect width="120" height="80" fill="none"/></svg>`;

const PNG_DATA_URI =
  RASTER_DATA_URI_PREFIX +
  // 1x1 transparent PNG.
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("classifyExportFormat (format-family dispatch, A2)", () => {
  it("routes svg-like formats to the svg family", () => {
    expect(classifyExportFormat("svg")).toBe("svg");
    expect(classifyExportFormat("xmlsvg")).toBe("svg");
  });

  it("routes png-like formats to the png family", () => {
    expect(classifyExportFormat("png")).toBe("png");
    expect(classifyExportFormat("xmlpng")).toBe("png");
  });

  it("returns null for unrequested/unknown formats so they are ignored", () => {
    expect(classifyExportFormat("html")).toBeNull();
    expect(classifyExportFormat("html2")).toBeNull();
    expect(classifyExportFormat("")).toBeNull();
    expect(classifyExportFormat(undefined)).toBeNull();
    expect(classifyExportFormat(null)).toBeNull();
  });
});

describe("normalizeRasterDataUri (A4)", () => {
  it("keeps an already-prefixed data URI unchanged", () => {
    expect(normalizeRasterDataUri(PNG_DATA_URI)).toBe(PNG_DATA_URI);
  });

  it("prepends the png data-URI prefix to a bare base64 value", () => {
    const bare = "iVBORw0KGgoAAAA";
    expect(normalizeRasterDataUri(bare)).toBe(RASTER_DATA_URI_PREFIX + bare);
  });
});

describe("injectRasterIntoSvg (string-splice injection, A4)", () => {
  it("injects data-raster into the opening <svg> tag, not the <?xml> prolog", () => {
    const out = injectRasterIntoSvg(DRAWIO_SVG, PNG_DATA_URI);

    // The attribute lands inside the <svg …> tag.
    const svgOpen = out.match(/<svg\b[^>]*>/)![0];
    expect(svgOpen).toContain(`${DRAWIO_RASTER_ATTR}="${PNG_DATA_URI}"`);

    // The prolog is untouched — no data-raster leaked before <svg.
    const prolog = out.slice(0, out.indexOf("<svg"));
    expect(prolog).toBe(`<?xml version="1.0" encoding="UTF-8"?>\n`);
    expect(prolog).not.toContain(DRAWIO_RASTER_ATTR);
  });

  it("leaves content=\"&lt;mxfile…\" byte-intact (no source corruption)", () => {
    const out = injectRasterIntoSvg(DRAWIO_SVG, PNG_DATA_URI);
    expect(out).toContain(MXFILE_ATTR);
    // No DOMParser round-trip: &lt; must NOT have become &amp;lt;.
    expect(out).not.toContain("&amp;lt;mxfile");
  });

  it("normalizes a bare-base64 raster value to a data-URI on inject", () => {
    const bare = "iVBORw0KGgoAAAA";
    const out = injectRasterIntoSvg(DRAWIO_SVG, bare);
    expect(out).toContain(
      `${DRAWIO_RASTER_ATTR}="${RASTER_DATA_URI_PREFIX}${bare}"`,
    );
  });

  it("replaces an existing data-raster instead of duplicating it", () => {
    const once = injectRasterIntoSvg(DRAWIO_SVG, PNG_DATA_URI);
    const twice = injectRasterIntoSvg(once, PNG_DATA_URI);
    const matches = twice.match(new RegExp(`${DRAWIO_RASTER_ATTR}=`, "g")) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("throws when there is no <svg> opening tag", () => {
    expect(() => injectRasterIntoSvg("<not-svg/>", PNG_DATA_URI)).toThrow();
  });
});

describe("isValidDrawioSvg (write guardrail, A5)", () => {
  it("accepts a real drawio SVG carrying the mxgraph source", () => {
    expect(isValidDrawioSvg(DRAWIO_SVG)).toBe(true);
    expect(
      isValidDrawioSvg(injectRasterIntoSvg(DRAWIO_SVG, PNG_DATA_URI)),
    ).toBe(true);
  });

  it("rejects a PNG data-URI", () => {
    expect(isValidDrawioSvg(PNG_DATA_URI)).toBe(false);
  });

  it("rejects an SVG that does not carry the drawio source", () => {
    expect(isValidDrawioSvg('<svg xmlns="x"><rect/></svg>')).toBe(false);
  });

  it("rejects empty / junk input", () => {
    expect(isValidDrawioSvg("")).toBe(false);
    expect(isValidDrawioSvg("garbage")).toBe(false);
  });

  // M1 (#629): the guardrail must not hard-fail EVERY save just because a
  // draw.io build emits the source with numeric char-refs (`&#60;`/`&#x3c;`) or
  // the older `<mxGraphModel` root instead of the named `&lt;mxfile`. It only
  // confirms "a real drawio SVG carrying its source"; accept every encoding.
  it("accepts a decimal char-ref source (content=\"&#60;mxfile…\")", () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" ` +
      `content="&#60;mxfile host=&quot;drawio&quot;&#62;&#60;/mxfile&#62;">` +
      `<rect/></svg>`;
    expect(isValidDrawioSvg(svg)).toBe(true);
  });

  it("accepts a decimal char-ref with leading zeros (content=\"&#060;mxfile…\")", () => {
    const svg =
      `<svg content="&#060;mxfile&#62;&#060;/mxfile&#62;"><rect/></svg>`;
    expect(isValidDrawioSvg(svg)).toBe(true);
  });

  it("accepts a hex char-ref source with the mxGraphModel root (content=\"&#x3C;mxGraphModel…\")", () => {
    const svg =
      `<?xml version="1.0"?>` +
      `<svg content="&#x3C;mxGraphModel dx=&quot;1&quot;&#x3E;&#x3C;/mxGraphModel&#x3E;">` +
      `<rect/></svg>`;
    expect(isValidDrawioSvg(svg)).toBe(true);
  });

  it("accepts a lowercase-hex char-ref with leading zeros (content=\"&#x03c;mxfile…\")", () => {
    const svg = `<svg content="&#x03c;mxfile&#x3e;"><rect/></svg>`;
    expect(isValidDrawioSvg(svg)).toBe(true);
  });

  it("still rejects a PNG data-URI even with the loosened source match", () => {
    expect(isValidDrawioSvg(PNG_DATA_URI)).toBe(false);
    expect(isValidDrawioSvg("data:image/png;base64,iVBORw0KAAA=")).toBe(false);
  });

  it("still rejects a plain <svg> with no drawio content= attribute", () => {
    expect(isValidDrawioSvg('<svg xmlns="x"><rect/></svg>')).toBe(false);
    // A content= that is NOT an encoded-`<`mxfile/mxGraphModel must not pass.
    expect(isValidDrawioSvg('<svg content="hello world"><rect/></svg>')).toBe(
      false,
    );
    // A LITERAL `<` (not entity-encoded) is not what a saved drawio SVG carries;
    // the source lives XML-escaped inside the attribute value.
    expect(isValidDrawioSvg('<svg content="<mxfile>"><rect/></svg>')).toBe(
      false,
    );
  });
});

describe("xmlStatesMatch (volatile-attr-insensitive compare, A3)", () => {
  const base =
    '<mxfile host="drawio" modified="2026-01-01T00:00:00.000Z" ' +
    'agent="Mozilla/5.0" etag="AAA" version="24.0.0">' +
    "<diagram><mxGraphModel><root>" +
    '<mxCell id="2" value="A"/></root></mxGraphModel></diagram></mxfile>';

  it("treats two exports differing only in modified/etag/agent as equal", () => {
    const other = base
      .replace('modified="2026-01-01T00:00:00.000Z"', 'modified="2026-09-09T09:09:09.000Z"')
      .replace('etag="AAA"', 'etag="ZZZ"')
      .replace('agent="Mozilla/5.0"', 'agent="Firefox/1.0"');
    expect(xmlStatesMatch(base, other)).toBe(true);
  });

  it("treats a real diagram-content change as unequal", () => {
    const changed = base.replace('value="A"', 'value="B"');
    expect(xmlStatesMatch(base, changed)).toBe(false);
  });

  it("strips all mxfile wrapper attrs, keeping the inner content", () => {
    const stripped = stripVolatileMxfileAttrs(base);
    // Every attribute on the <mxfile> wrapper is gone — it is now bare.
    expect(stripped).toContain("<mxfile>");
    expect(stripped).not.toContain('host="drawio"');
    expect(stripped).not.toContain("modified=");
    expect(stripped).not.toContain("etag=");
    expect(stripped).not.toContain("agent=");
    // The children (the actual diagram content) are preserved untouched.
    expect(stripped).toContain(
      "<diagram><mxGraphModel><root>" +
        '<mxCell id="2" value="A"/></root></mxGraphModel></diagram></mxfile>',
    );
  });

  it("preserves a self-closing <mxfile/> when stripping attrs", () => {
    expect(stripVolatileMxfileAttrs('<mxfile host="drawio"/>')).toBe(
      "<mxfile/>",
    );
    expect(stripVolatileMxfileAttrs("<mxfile/>")).toBe("<mxfile/>");
  });

  it("treats empty/absent png xml as a match (png export returns no xml)", () => {
    expect(xmlStatesMatch(base, "")).toBe(true);
    expect(xmlStatesMatch("", base)).toBe(true);
    expect(xmlStatesMatch(base, undefined as any)).toBe(true);
  });

  it("treats two exports differing only in a non-content mxfile attr (host/type/pages) as equal", () => {
    const variant = base
      .replace('host="drawio"', 'host="embed.diagrams.net"')
      .replace('<mxfile ', '<mxfile pages="1" ');
    expect(xmlStatesMatch(base, variant)).toBe(true);
  });
});

describe("decodedBase64ByteLength + budget (A6)", () => {
  it("computes decoded length for a data-URI and a bare base64", () => {
    // "AAAA" decodes to 3 bytes; one '=' -> 2 bytes; two '=' -> 1 byte.
    expect(decodedBase64ByteLength("AAAA")).toBe(3);
    expect(decodedBase64ByteLength("AAA=")).toBe(2);
    expect(decodedBase64ByteLength("AA==")).toBe(1);
    expect(decodedBase64ByteLength("data:image/png;base64,AAAA")).toBe(3);
    expect(decodedBase64ByteLength("")).toBe(0);
  });

  it("a small png is within budget; a >2 MiB decoded png is over (downscale path)", () => {
    expect(isWithinRasterBudget(decodedBase64ByteLength(PNG_DATA_URI))).toBe(true);

    // Build a base64 whose DECODED size exceeds 2 MiB.
    const overBytes = MAX_RASTER_BYTES + 1024;
    const b64Len = Math.ceil(overBytes / 3) * 4;
    const bigB64 = "A".repeat(b64Len);
    const decoded = decodedBase64ByteLength(RASTER_DATA_URI_PREFIX + bigB64);
    expect(decoded).toBeGreaterThan(MAX_RASTER_BYTES);
    // Over budget -> generateRaster would downscale, and if STILL over, drop it.
    expect(isWithinRasterBudget(decoded)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Extracted hook decision logic (#629 M3): the state-machine cores lifted out
// of use-drawio-raster-save.ts so they get real regression protection.
// ---------------------------------------------------------------------------

describe("resolveExportFamily (onExport dispatch decision, A2)", () => {
  const pending = (...families: ExportFamily[]) => {
    const set = new Set(families);
    return (f: ExportFamily) => set.has(f);
  };

  it("routes a response to its family when that family is pending", () => {
    expect(resolveExportFamily("xmlsvg", pending("svg"))).toBe("svg");
    expect(resolveExportFamily("png", pending("png", "svg"))).toBe("png");
    expect(resolveExportFamily("xmlpng", pending("png"))).toBe("png");
  });

  it("ignores a response whose family is NOT pending (stray/duplicate)", () => {
    // draw.io's own auto-xmlsvg on Save while only png is awaited, etc.
    expect(resolveExportFamily("xmlsvg", pending("png"))).toBeNull();
    expect(resolveExportFamily("png", pending())).toBeNull();
  });

  it("ignores an unknown/unrequested format regardless of pending state", () => {
    expect(resolveExportFamily("html", pending("svg", "png"))).toBeNull();
    expect(resolveExportFamily(undefined, pending("svg", "png"))).toBeNull();
    expect(resolveExportFamily(null, pending("svg", "png"))).toBeNull();
    expect(resolveExportFamily("", pending("svg", "png"))).toBeNull();
  });
});

describe("nextCircuitBreakerState (png circuit-breaker, A6)", () => {
  const T = RASTER_CIRCUIT_BREAKER_THRESHOLD; // 3

  it("opens the breaker after N CONSECUTIVE failures", () => {
    let s = { failCount: 0, broken: false };
    for (let i = 1; i < T; i++) {
      s = nextCircuitBreakerState(s, "failure", T);
      expect(s.broken).toBe(false);
      expect(s.failCount).toBe(i);
    }
    s = nextCircuitBreakerState(s, "failure", T);
    expect(s.failCount).toBe(T);
    expect(s.broken).toBe(true);
  });

  it("a raster success resets the failure streak (never opens)", () => {
    let s = { failCount: T - 1, broken: false };
    s = nextCircuitBreakerState(s, "raster", T);
    expect(s.failCount).toBe(0);
    expect(s.broken).toBe(false);
    // A fresh failure after the reset does not immediately open.
    s = nextCircuitBreakerState(s, "failure", T);
    expect(s.broken).toBe(false);
  });

  it("an over-budget/mismatch SKIP resets the streak and never counts as a failure", () => {
    let s = { failCount: T - 1, broken: false };
    s = nextCircuitBreakerState(s, "skip", T);
    expect(s.failCount).toBe(0);
    expect(s.broken).toBe(false);
  });

  it("interleaving a success between failures prevents the breaker from opening", () => {
    let s = { failCount: 0, broken: false };
    s = nextCircuitBreakerState(s, "failure", T); // 1
    s = nextCircuitBreakerState(s, "failure", T); // 2
    s = nextCircuitBreakerState(s, "raster", T); // reset -> 0
    s = nextCircuitBreakerState(s, "failure", T); // 1
    s = nextCircuitBreakerState(s, "failure", T); // 2
    expect(s.broken).toBe(false);
  });

  it("once open, the breaker stays latched (a later completed export cannot re-close it)", () => {
    let s = { failCount: T, broken: true };
    s = nextCircuitBreakerState(s, "raster", T);
    expect(s.broken).toBe(true);
    s = nextCircuitBreakerState(s, "skip", T);
    expect(s.broken).toBe(true);
  });
});

describe("resolveEffectiveUpdateSrc (coalesced-save updateSrc, A7/M2)", () => {
  it("an explicit Save (true) coalescing onto an autosave (false) keeps true", () => {
    // The running save started as an autosave (updateSrc:false); an explicit
    // Save coalesces on and MUST NOT be downgraded, or the node src goes stale.
    expect(resolveEffectiveUpdateSrc(false, true)).toBe(true);
  });

  it("an autosave (false) coalescing onto an explicit Save (true) stays true", () => {
    expect(resolveEffectiveUpdateSrc(true, false)).toBe(true);
  });

  it("preserves the trivial cases", () => {
    expect(resolveEffectiveUpdateSrc(false, false)).toBe(false);
    expect(resolveEffectiveUpdateSrc(true, true)).toBe(true);
  });
});

describe("raster scale ladder (retina quality)", () => {
  it("exports at 2x primary for crisp hi-DPI output", () => {
    expect(RASTER_PRIMARY_SCALE).toBe(2);
  });

  it("downscale steps are strictly descending and below the primary scale", () => {
    // The budget fallback walks these in order, so they MUST be sorted
    // high->low and all be smaller than the primary scale (else a downscale
    // would keep or raise the byte size, defeating the budget).
    expect(RASTER_DOWNSCALE_STEPS.length).toBeGreaterThan(0);
    let prev = RASTER_PRIMARY_SCALE;
    for (const s of RASTER_DOWNSCALE_STEPS) {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(prev);
      prev = s;
    }
  });
});
