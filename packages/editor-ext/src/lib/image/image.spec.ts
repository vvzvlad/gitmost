import { describe, it, expect, beforeEach } from "vitest";
import { getSchema } from "@tiptap/core";
import { generateHTML, generateJSON } from "@tiptap/html";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { applyAlignment, TiptapImage } from "./image";

// CONTRACT tests for the image node's `caption` attribute (issue #221). The
// caption is a plain-text string stored on the image atom and serialized as
// `data-caption` on the <img>. If this mapping drifts, captions saved to HTML
// (and thus to native storage / search / markdown) are silently lost.
const extensions = [Document, Paragraph, Text, TiptapImage];

// applyAlignment is a pure DOM mutation: it sets the float / padding /
// justify-content / data-image-align on an image node-view container per the
// resolved `align`. Tested directly (issue #145 review) since the five-way
// branch, the reset-then-apply guard, and the data-image-align mirror (which the
// responsive @media rule keys off) are otherwise uncovered.

describe("applyAlignment", () => {
  let el: HTMLElement;
  beforeEach(() => {
    el = document.createElement("div");
  });

  it("floatLeft -> float:left + right padding, mirrored on data-image-align", () => {
    applyAlignment(el, "floatLeft");
    expect(el.style.cssFloat).toBe("left");
    expect(el.style.padding).toBe("0px 10px 0px 0px");
    expect(el.dataset.imageAlign).toBe("floatLeft");
    expect(el.style.justifyContent).toBe("flex-start");
  });

  it("floatRight -> float:right + left padding", () => {
    applyAlignment(el, "floatRight");
    expect(el.style.cssFloat).toBe("right");
    expect(el.style.padding).toBe("0px 0px 0px 10px");
    expect(el.dataset.imageAlign).toBe("floatRight");
    expect(el.style.justifyContent).toBe("flex-end");
  });

  it("left -> justify flex-start, no float", () => {
    applyAlignment(el, "left");
    expect(el.style.justifyContent).toBe("flex-start");
    expect(el.style.cssFloat).toBe("");
    expect(el.style.padding).toBe("");
    expect(el.dataset.imageAlign).toBe("left");
  });

  it("right -> justify flex-end, no float", () => {
    applyAlignment(el, "right");
    expect(el.style.justifyContent).toBe("flex-end");
    expect(el.style.cssFloat).toBe("");
    expect(el.dataset.imageAlign).toBe("right");
  });

  it("center (default) -> justify center, no float", () => {
    applyAlignment(el, "center");
    expect(el.style.justifyContent).toBe("center");
    expect(el.style.cssFloat).toBe("");
    expect(el.style.padding).toBe("");
    expect(el.dataset.imageAlign).toBe("center");
  });

  it("clears a previous float when switching floatLeft -> left (reset-then-apply)", () => {
    applyAlignment(el, "floatLeft");
    expect(el.style.cssFloat).toBe("left");
    expect(el.style.padding).toBe("0px 10px 0px 0px");
    // Switching to a block alignment must drop the float and its padding, not
    // leak them (the bug the reset guard prevents).
    applyAlignment(el, "left");
    expect(el.style.cssFloat).toBe("");
    expect(el.style.padding).toBe("");
    expect(el.dataset.imageAlign).toBe("left");
    expect(el.style.justifyContent).toBe("flex-start");
  });
});

describe("image schema", () => {
  it("registers the image node and keeps it an atom", () => {
    const schema = getSchema(extensions);
    expect(schema.nodes.image).toBeTruthy();
    expect(schema.nodes.image.spec.atom).toBe(true);
  });
});

describe("image caption parse/render round-trip", () => {
  it("recovers caption from data-caption on parse (HTML -> JSON)", () => {
    const html = `<img src="/files/a.png" alt="cat" data-caption="A grey cat">`;
    const json = generateJSON(html, extensions);

    const node = json.content?.[0];
    expect(node?.type).toBe("image");
    expect(node?.attrs?.caption).toBe("A grey cat");
    expect(node?.attrs?.alt).toBe("cat");
  });

  it("emits data-caption on render when set (JSON -> HTML)", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: { src: "/files/a.png", alt: "cat", caption: "A grey cat" },
        },
      ],
    };
    const html = generateHTML(json, extensions);
    expect(html).toContain('data-caption="A grey cat"');
  });

  it("omits data-caption when there is no caption (caption-less images stay clean)", () => {
    const json = {
      type: "doc",
      content: [{ type: "image", attrs: { src: "/files/a.png", alt: "cat" } }],
    };
    const html = generateHTML(json, extensions);
    expect(html).not.toContain("data-caption");
  });

  it("full HTML -> JSON -> HTML round-trip preserves the caption", () => {
    const html = `<img src="/files/a.png" alt="cat" data-caption="Caption with &amp; &quot;quotes&quot;">`;
    const json = generateJSON(html, extensions);
    expect(json.content?.[0]?.attrs?.caption).toBe('Caption with & "quotes"');

    const out = generateHTML(json, extensions);
    const back = generateJSON(out, extensions);
    expect(back.content?.[0]?.attrs?.caption).toBe('Caption with & "quotes"');
  });
});
