import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { renderRawHtml, shouldExecute, canEdit } from "./render-raw-html";

// jsdom does NOT execute <script> nodes unless its instance was created with
// `runScripts: "dangerously"`. The whole point of renderRawHtml is to make
// re-created scripts run, so the execution tests drive a dedicated script-
// running JSDOM and pass it a container from THAT document (renderRawHtml uses
// `container.ownerDocument`, so it creates the fresh scripts in the running
// instance). The default vitest jsdom (no runScripts) is used for the
// structural and policy assertions.
describe("renderRawHtml (script execution against a runScripts jsdom)", () => {
  let dom: JSDOM;
  let container: HTMLElement;

  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", {
      runScripts: "dangerously",
    });
    container = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container);
  });

  afterEach(() => {
    dom.window.close();
  });

  it("re-creates and executes an inline <script> (observable side effect)", () => {
    renderRawHtml(
      container,
      "<div>hello</div><script>window.__htmlEmbedFlag = true;</script>",
    );
    // The re-created inline script ran inside the jsdom window.
    expect((dom.window as unknown as Record<string, unknown>).__htmlEmbedFlag).toBe(
      true,
    );
    // The non-script markup is preserved.
    expect(container.querySelector("div")?.textContent).toBe("hello");
  });

  it("copies src/async/defer onto a re-created external <script src>", () => {
    renderRawHtml(
      container,
      '<script src="https://example.com/t.js" async defer></script>',
    );
    const script = container.querySelector("script");
    expect(script).not.toBeNull();
    expect(script?.getAttribute("src")).toBe("https://example.com/t.js");
    expect(script?.hasAttribute("async")).toBe(true);
    expect(script?.hasAttribute("defer")).toBe(true);
  });

  it("clears the container when the source is empty", () => {
    container.innerHTML = "<p>stale</p>";
    renderRawHtml(container, "");
    expect(container.innerHTML).toBe("");
  });

  it("clears prior content first on a re-render with new source", () => {
    const win = dom.window as unknown as Record<string, unknown>;
    renderRawHtml(
      container,
      "<span id='first'>one</span><script>window.__htmlEmbedCount = 1;</script>",
    );
    expect(win.__htmlEmbedCount).toBe(1);
    expect(container.querySelector("#first")).not.toBeNull();

    renderRawHtml(
      container,
      "<span id='second'>two</span><script>window.__htmlEmbedCount = 2;</script>",
    );
    // Prior content is gone; only the new render remains.
    expect(container.querySelector("#first")).toBeNull();
    expect(container.querySelector("#second")).not.toBeNull();
    expect(win.__htmlEmbedCount).toBe(2);
  });
});

describe("shouldExecute (execution policy)", () => {
  it("read-only executes regardless of the workspace toggle", () => {
    // isEditable=false → the server already gated the content.
    expect(shouldExecute(false, false)).toBe(true);
    expect(shouldExecute(false, true)).toBe(true);
  });

  it("editable + toggle OFF does NOT execute", () => {
    expect(shouldExecute(true, false)).toBe(false);
  });

  it("editable + toggle ON executes", () => {
    expect(shouldExecute(true, true)).toBe(true);
  });
});

describe("canEdit (edit policy)", () => {
  it("a member (non-admin) can never edit", () => {
    expect(canEdit(true, false, true)).toBe(false);
    expect(canEdit(false, false, true)).toBe(false);
  });

  it("an admin with the toggle OFF cannot edit", () => {
    expect(canEdit(true, true, false)).toBe(false);
  });

  it("an admin with the toggle ON in editable mode can edit", () => {
    expect(canEdit(true, true, true)).toBe(true);
  });

  it("an admin in read-only mode cannot edit (no edit affordance)", () => {
    expect(canEdit(false, true, true)).toBe(false);
  });
});
