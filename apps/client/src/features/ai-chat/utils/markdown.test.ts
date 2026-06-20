import { describe, expect, it } from "vitest";
import { renderChatMarkdown } from "@/features/ai-chat/utils/markdown.ts";

/**
 * Tests for the internal-link neutralization used by the anonymous public
 * share. Now that the share renders the assistant's MARKDOWN (not plain text),
 * internal app links (e.g. `[page](/p/{uuid})`) would otherwise become clickable
 * `<a href="/p/...">`, leaking internal UUIDs/structure and linking to auth-gated
 * routes. With the flag ON those links are made inert (href removed) while the
 * visible text and the rest of the markdown formatting are preserved; genuinely
 * EXTERNAL http(s) links are kept with a safe rel/target. With the flag OFF
 * (internal default) links keep their href so the authenticated chat is unchanged.
 */

/** Parse the rendered HTML and return the first <a> element (or null). */
function firstAnchor(html: string): HTMLAnchorElement | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.querySelector("a");
}

describe("renderChatMarkdown — internal link neutralization", () => {
  it("makes an internal link inert when the flag is ON (no href, text kept)", () => {
    const html = renderChatMarkdown("[x](/p/abc)", {
      neutralizeInternalLinks: true,
    });
    const a = firstAnchor(html);
    expect(a).not.toBeNull();
    expect(a!.hasAttribute("href")).toBe(false);
    expect(a!.hasAttribute("target")).toBe(false);
    // Visible link text is preserved.
    expect(a!.textContent).toBe("x");
  });

  it("neutralizes bare-fragment links when the flag is ON", () => {
    const html = renderChatMarkdown("[here](#section)", {
      neutralizeInternalLinks: true,
    });
    const a = firstAnchor(html);
    expect(a).not.toBeNull();
    expect(a!.hasAttribute("href")).toBe(false);
  });

  it("keeps an external http(s) link with a safe rel/target when the flag is ON", () => {
    const html = renderChatMarkdown("[y](https://example.com)", {
      neutralizeInternalLinks: true,
    });
    const a = firstAnchor(html);
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("https://example.com");
    expect(a!.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(a!.getAttribute("target")).toBe("_blank");
  });

  it("keeps internal links clickable when the flag is OFF (internal default)", () => {
    const html = renderChatMarkdown("[x](/p/abc)");
    const a = firstAnchor(html);
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("/p/abc");
  });

  it("does not leave a global DOMPurify hook that affects a later internal render", () => {
    // A neutralizing render first, then an internal render: the internal link
    // must survive (the hook is removed after the share render).
    renderChatMarkdown("[x](/p/abc)", { neutralizeInternalLinks: true });
    const html = renderChatMarkdown("[x](/p/abc)");
    const a = firstAnchor(html);
    expect(a!.getAttribute("href")).toBe("/p/abc");
  });
});
