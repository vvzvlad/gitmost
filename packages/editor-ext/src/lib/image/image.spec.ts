import { describe, it, expect, beforeEach } from "vitest";
import { applyAlignment } from "./image";

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
