import { describe, it, expect } from "vitest";
import { computeSpaceSlug, decodeBase64ToSvgString } from "@/lib/utils.tsx";

// `computeSpaceSlug` derives a space slug that must satisfy the server-side
// @IsAlphanumeric / ^[a-zA-Z0-9]+$ constraint: lowercase the name and strip
// every non-[a-z0-9] character (spaces, punctuation, and non-ascii letters).
// No hyphens, no uppercase, no separators survive.
describe("computeSpaceSlug", () => {
  it("strips the space between two words", () => {
    expect(computeSpaceSlug("Product Team")).toBe("productteam");
  });

  it("lowercases and joins a two-word name", () => {
    expect(computeSpaceSlug("Hello World")).toBe("helloworld");
  });

  it("lowercases a single word with no separators", () => {
    expect(computeSpaceSlug("SingleWord")).toBe("singleword");
  });

  it("lowercases an all-caps word and removes the inner space", () => {
    expect(computeSpaceSlug("UPPER case")).toBe("uppercase");
  });

  it("drops non-ascii characters, keeping ascii letters and digits", () => {
    // "Привет" (Cyrillic) is stripped entirely; only "a", "b" and "1" remain.
    expect(computeSpaceSlug("a b Привет 1")).toBe("ab1");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(computeSpaceSlug("  ")).toBe("");
  });

  it("always produces output matching /^[a-z0-9]*$/", () => {
    const samples = [
      "Product Team",
      "Hello World",
      "SingleWord",
      "UPPER case",
      "a b Привет 1",
      "  ",
      "Mixed-123 !@#",
      "Café Münster",
    ];
    for (const sample of samples) {
      expect(computeSpaceSlug(sample)).toMatch(/^[a-z0-9]*$/);
    }
  });
});

// ---------------------------------------------------------------------------
// decodeBase64ToSvgString — the draw.io editor LOAD path (#584).
//
// When opening an existing diagram, drawio-menu's handleOpen reads the fetched
// `.drawio.svg` attachment as a base64 `data:` URL and must hand the editor a
// UTF-8-correct SVG string. draw.io's own load handler atob-decodes a base64
// `data:` URL as Latin-1 (no UTF-8 step), so passing it the RAW data URL turns
// every multibyte UTF-8 char (Cyrillic is 2 bytes) inside content= into
// mojibake (`Ð...`) which autosave then PERSISTS -> data loss. decodeBase64-
// ToSvgString decodes the OUTER data-URL base64 via TextDecoder (proper UTF-8)
// and leaves the inner content= payload untouched.
// ---------------------------------------------------------------------------

// Encode a JS string to a `data:image/svg+xml;base64,<...>` URL exactly the way
// FileReader.readAsDataURL does for an image/svg+xml blob: base64 of the UTF-8
// bytes of the string.
function toSvgDataUrl(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return "data:image/svg+xml;base64," + btoa(binary);
}

// Model exactly what draw.io does to the RAW data URL the OLD code passed as
// `xml` (setInitialXML(base64data)): strip the prefix and atob-decode, which
// interprets each byte as a Latin-1 code point (NO UTF-8 decode) -> mojibake.
function drawioLatin1Decode(dataUrl: string): string {
  const b64 = dataUrl.replace("data:image/svg+xml;base64,", "");
  return atob(b64);
}

// Entity-encode a string for an XML attribute value, matching the server's
// buildDrawioSvg / draw.io's own native SVG export (content= holds the mxfile).
function xmlEscapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

describe("decodeBase64ToSvgString (drawio editor load path, #584)", () => {
  // A real saved `.drawio.svg` payload: the mxfile XML lives ENTITY-encoded in
  // content= (draw.io's native form, which #507 made us write), with a Cyrillic
  // label value="Наладка станка".
  const mxfile =
    '<mxfile host="drawio"><diagram id="page-1" name="Page-1">' +
    "<mxGraphModel><root>" +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="Наладка станка" style="rounded=0" vertex="1" parent="1">' +
    '<mxGeometry x="40" y="40" width="160" height="40" as="geometry"/>' +
    "</mxCell></root></mxGraphModel></diagram></mxfile>";

  const entitySvg =
    '<svg xmlns="http://www.w3.org/2000/svg" ' +
    'xmlns:xlink="http://www.w3.org/1999/xlink" ' +
    'width="220" height="120" viewBox="0 0 220 120" ' +
    `content="${xmlEscapeAttr(mxfile)}">` +
    "<rect width=\"220\" height=\"120\" fill=\"none\"/></svg>";

  it("decodes an entity-XML content= diagram to clean UTF-8 (no mojibake)", () => {
    const dataUrl = toSvgDataUrl(entitySvg);

    const decoded = decodeBase64ToSvgString(dataUrl);

    // The load payload handed to the editor is proper UTF-8: the Cyrillic label
    // survives intact, and the SVG round-trips byte-for-byte.
    expect(decoded).toContain("Наладка станка");
    expect(decoded).toBe(entitySvg);
  });

  it("is NON-VACUOUS: the old raw-data-URL path yields mojibake, not Cyrillic", () => {
    const dataUrl = toSvgDataUrl(entitySvg);

    // The OLD code did setInitialXML(base64data) -> draw.io Latin-1-decodes it.
    const oldPathAsDrawioSees = drawioLatin1Decode(dataUrl);
    expect(oldPathAsDrawioSees).not.toContain("Наладка");
    // Classic UTF-8-read-as-Latin-1 mojibake: the 0xD0 lead byte -> "Ð".
    expect(oldPathAsDrawioSees).toContain("Ð");

    // And the raw data URL itself (what the old code stored in initialXML) never
    // contains the literal Cyrillic string either — so asserting the fixed
    // output contains "Наладка станка" fails against the old behavior.
    expect(dataUrl).not.toContain("Наладка");
  });

  // #629 (A5 / acceptance #7): the decoder must THROW rather than hand back a
  // non-SVG payload, so a PNG can never be smuggled into the `.svg` upload path.
  const PNG_BODY_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  it("throws on a data:image/png data URL (never decodes a PNG as SVG)", () => {
    expect(() =>
      decodeBase64ToSvgString("data:image/png;base64," + PNG_BODY_B64),
    ).toThrow();
  });

  it("throws on a bare base64 that decodes to non-SVG (PNG) bytes", () => {
    // No data: prefix, but the decoded bytes are a PNG (start with the 0x89 'PNG'
    // signature), not `<svg`/`<?xml` -> must throw.
    expect(() => decodeBase64ToSvgString(PNG_BODY_B64)).toThrow();
  });

  it("back-compat: a legacy base64 content= diagram still decodes/opens", () => {
    // Older attachments stored the mxfile as base64 inside content= (not entity
    // XML). decodeBase64ToSvgString only decodes the OUTER data-URL base64, so
    // the inner base64 content= must survive verbatim and reach the editor
    // exactly as before this fix (its own Latin-1 handling of that inner blob is
    // the separate, pre-existing #507 concern — NOT regressed here).
    const innerBytes = new TextEncoder().encode(mxfile);
    let innerBinary = "";
    for (const b of innerBytes) innerBinary += String.fromCharCode(b);
    const legacyInnerB64 = btoa(innerBinary);

    const legacySvg =
      '<svg xmlns="http://www.w3.org/2000/svg" ' +
      `content="${legacyInnerB64}">` +
      "<rect/></svg>";

    const decoded = decodeBase64ToSvgString(toSvgDataUrl(legacySvg));

    // Outer wrapper decoded, inner base64 payload untouched -> still opens.
    expect(decoded).toBe(legacySvg);
    expect(decoded).toContain(legacyInnerB64);
  });
});
