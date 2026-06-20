import { describe, it, expect } from "vitest";
import {
  buildSandboxSrcdoc,
  canEdit,
  HTML_EMBED_HEIGHT_MESSAGE,
  shouldExecute,
} from "./render-raw-html";

describe("buildSandboxSrcdoc", () => {
  it("embeds the user source verbatim", () => {
    const out = buildSandboxSrcdoc("<div id='x'>hello</div>");
    expect(out).toContain("<div id='x'>hello</div>");
  });

  it("injects the height-postMessage bootstrap after the source", () => {
    const out = buildSandboxSrcdoc("<p>body</p>");
    // The bootstrap is appended AFTER the source.
    expect(out.indexOf("<p>body</p>")).toBeLessThan(
      out.indexOf(HTML_EMBED_HEIGHT_MESSAGE),
    );
    // It reports its height to the parent via postMessage with the agreed type.
    expect(out).toContain("parent.postMessage");
    expect(out).toContain(HTML_EMBED_HEIGHT_MESSAGE);
    // It observes resizes so the parent can keep the iframe sized to fit.
    expect(out).toContain("ResizeObserver");
    expect(out).toContain('addEventListener("load"');
  });

  it("handles an empty source (still injects the bootstrap)", () => {
    const out = buildSandboxSrcdoc("");
    expect(out).toContain(HTML_EMBED_HEIGHT_MESSAGE);
  });
});

describe("shouldExecute (render policy)", () => {
  it("read-only renders regardless of the workspace toggle", () => {
    // isEditable=false → the server already gated the content.
    expect(shouldExecute(false, false)).toBe(true);
    expect(shouldExecute(false, true)).toBe(true);
  });

  it("editable + toggle OFF does NOT render", () => {
    expect(shouldExecute(true, false)).toBe(false);
  });

  it("editable + toggle ON renders", () => {
    expect(shouldExecute(true, true)).toBe(true);
  });
});

describe("canEdit (edit policy)", () => {
  it("any member can edit when editable and the toggle is ON (no admin gate)", () => {
    expect(canEdit(true, true)).toBe(true);
  });

  it("cannot edit when the toggle is OFF", () => {
    expect(canEdit(true, false)).toBe(false);
  });

  it("cannot edit in read-only mode (no edit affordance)", () => {
    expect(canEdit(false, true)).toBe(false);
  });
});
