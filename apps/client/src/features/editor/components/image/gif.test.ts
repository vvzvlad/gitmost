import { describe, expect, it } from "vitest";
import { gifFromClipboard, isImageFile } from "./gif";

describe("GIF insertion", () => {
  it("accepts GIF files even when the browser omits their MIME type", () => {
    for (const type of ["image/gif", "", "application/octet-stream"]) {
      expect(isImageFile({ name: "animation.GIF", type })).toBe(true);
    }
    expect(isImageFile({ name: "picture.png", type: "image/png" })).toBe(true);
    expect(isImageFile({ name: "notes.txt", type: "" })).toBe(false);
    expect(isImageFile({ name: "video.gif", type: "video/mp4" })).toBe(false);
  });

  it("inserts direct GIF URLs with query strings as images", () => {
    expect(
      gifFromClipboard(" https://example.org/animation.GIF?v=1#frame ", ""),
    ).toEqual({
      src: "https://example.org/animation.GIF?v=1#frame",
    });
  });

  it("keeps the original GIF from image-only HTML rather than a clipboard PNG", () => {
    expect(
      gifFromClipboard(
        "",
        '<a href="https://example.org"><img src="https://example.org/a.gif" alt="Demo"></a>',
      ),
    ).toEqual({ src: "https://example.org/a.gif", alt: "Demo" });
  });

  it.each([
    "javascript:alert(1).gif",
    "data:image/gif;base64,R0lGODlh",
    "file:///demo.gif",
    "https://example.org/page",
    "https://example.org/demo.png",
    "Text https://example.org/a.gif",
  ])(
    "leaves unsupported clipboard text to the normal paste handler: %s",
    (text) => {
      expect(gifFromClipboard(text, "")).toBeNull();
    },
  );

  it("leaves wiki attachment copies on the existing permission-aware reupload path", () => {
    expect(
      gifFromClipboard(
        "https://example.org/a.gif",
        '<img src="https://example.org/a.gif" data-attachment-id="id">',
      ),
    ).toBeNull();
    expect(
      gifFromClipboard(
        "https://example.org/a.gif",
        "<table><tr><td>https://example.org/a.gif</td></tr></table>",
      ),
    ).toBeNull();
  });

  it("preserves rich fragments, tables, and multiple images", () => {
    for (const html of [
      '<p>A caption</p><img src="https://example.org/a.gif">',
      '<table><tr><td><img src="https://example.org/a.gif"></td></tr></table>',
      '<img src="https://example.org/a.gif"><img src="https://example.org/b.gif">',
      '<img src="https://example.org/a.png">',
      '<img src="javascript:alert(1).gif">',
    ])
      expect(gifFromClipboard("", html)).toBeNull();
  });
});
