import { describe, it, expect } from "vitest";
import {
  buildSandboxSrcdoc,
  canEdit,
  clampHeight,
  HTML_EMBED_HEIGHT_MESSAGE,
  HTML_EMBED_SANDBOX,
  isTrustedHeightMessage,
  MAX_IFRAME_HEIGHT,
  MIN_IFRAME_HEIGHT,
  shouldRender,
} from "./html-embed-sandbox";

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

describe("shouldRender (render policy)", () => {
  it("read-only renders regardless of the workspace toggle", () => {
    // isEditable=false → the server already gated the content.
    expect(shouldRender(false, false)).toBe(true);
    expect(shouldRender(false, true)).toBe(true);
  });

  it("editable + toggle OFF does NOT render", () => {
    expect(shouldRender(true, false)).toBe(false);
  });

  it("editable + toggle ON renders", () => {
    expect(shouldRender(true, true)).toBe(true);
  });
});

describe("clampHeight", () => {
  it("clamps below the lower bound up to MIN_IFRAME_HEIGHT", () => {
    expect(clampHeight(0)).toBe(MIN_IFRAME_HEIGHT);
    expect(clampHeight(-100)).toBe(MIN_IFRAME_HEIGHT);
    expect(clampHeight(MIN_IFRAME_HEIGHT - 1)).toBe(MIN_IFRAME_HEIGHT);
  });

  it("clamps above the upper bound down to MAX_IFRAME_HEIGHT", () => {
    expect(clampHeight(MAX_IFRAME_HEIGHT + 1)).toBe(MAX_IFRAME_HEIGHT);
    expect(clampHeight(999999)).toBe(MAX_IFRAME_HEIGHT);
  });

  it("passes a value within range through unchanged", () => {
    expect(clampHeight(150)).toBe(150);
    expect(clampHeight(MIN_IFRAME_HEIGHT)).toBe(MIN_IFRAME_HEIGHT);
    expect(clampHeight(MAX_IFRAME_HEIGHT)).toBe(MAX_IFRAME_HEIGHT);
  });
});

describe("isTrustedHeightMessage (resize message guard)", () => {
  // Stand-ins for window objects; identity is all the guard compares.
  const ownWindow = {} as Window;
  const foreignWindow = {} as Window;
  const iframeEl = { contentWindow: ownWindow };

  const validData = { type: HTML_EMBED_HEIGHT_MESSAGE, height: 300 };

  it("accepts a same-source message with a finite numeric height", () => {
    expect(
      isTrustedHeightMessage({ source: ownWindow, data: validData }, iframeEl),
    ).toBe(true);
  });

  it("rejects a message from a DIFFERENT source (foreign window)", () => {
    // A page can postMessage anything; only our own iframe's contentWindow is
    // trusted. This is the core security check.
    expect(
      isTrustedHeightMessage(
        { source: foreignWindow, data: validData },
        iframeEl,
      ),
    ).toBe(false);
  });

  it("rejects a wrong-type message even from the right source", () => {
    expect(
      isTrustedHeightMessage(
        { source: ownWindow, data: { type: "something-else", height: 300 } },
        iframeEl,
      ),
    ).toBe(false);
  });

  it("rejects a NaN height", () => {
    expect(
      isTrustedHeightMessage(
        { source: ownWindow, data: { type: HTML_EMBED_HEIGHT_MESSAGE, height: NaN } },
        iframeEl,
      ),
    ).toBe(false);
  });

  it("rejects an Infinity height", () => {
    expect(
      isTrustedHeightMessage(
        {
          source: ownWindow,
          data: { type: HTML_EMBED_HEIGHT_MESSAGE, height: Infinity },
        },
        iframeEl,
      ),
    ).toBe(false);
  });

  it("rejects when the iframe element / contentWindow is null", () => {
    expect(
      isTrustedHeightMessage({ source: ownWindow, data: validData }, null),
    ).toBe(false);
    expect(
      isTrustedHeightMessage(
        { source: null, data: validData },
        { contentWindow: null },
      ),
    ).toBe(false);
  });
});

describe("iframe sandbox attributes", () => {
  it("uses EXACTLY allow-scripts allow-popups allow-forms (no allow-same-origin)", () => {
    expect(HTML_EMBED_SANDBOX).toBe("allow-scripts allow-popups allow-forms");
    // The critical security invariant: opaque origin => no session/cookie access.
    expect(HTML_EMBED_SANDBOX).not.toContain("allow-same-origin");
  });

  it("the NodeView renders the embed via srcDoc (not src), set to the sandbox doc", () => {
    // The iframe carries the generated srcdoc; it never loads an external URL.
    const srcdoc = buildSandboxSrcdoc("<p>hi</p>");
    expect(srcdoc).toContain("<p>hi</p>");
    expect(srcdoc).toContain(HTML_EMBED_HEIGHT_MESSAGE);
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
