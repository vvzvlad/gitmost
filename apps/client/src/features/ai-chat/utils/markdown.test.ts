import { describe, expect, it } from "vitest";
import { renderChatMarkdown } from "@/features/ai-chat/utils/markdown.ts";

/**
 * Tests for the internal-link neutralization used by the anonymous public
 * share. Now that the share renders the assistant's MARKDOWN (not plain text),
 * internal app links (e.g. `[page](/p/{uuid})`) would otherwise become clickable
 * `<a href="/p/...">`, leaking internal UUIDs/structure and linking to auth-gated
 * routes. With the flag ON those links are made inert (href removed) while the
 * visible text and the rest of the markdown formatting are preserved; genuinely
 * EXTERNAL http(s) links (a DIFFERENT host than the app's own origin) are kept
 * with a safe rel/target, while absolute links back to our OWN origin are
 * neutralized too. With the flag OFF (internal default) links keep their href so
 * the authenticated chat is unchanged.
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
    const html = renderChatMarkdown("[y](https://example.com/x)", {
      neutralizeInternalLinks: true,
    });
    const a = firstAnchor(html);
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("https://example.com/x");
    expect(a!.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(a!.getAttribute("target")).toBe("_blank");
  });

  it("neutralizes an absolute link to our OWN origin when the flag is ON", () => {
    // An LLM can emit an absolute URL back at our own host (e.g.
    // `http://self/p/{uuid}`); it is internal and must be made inert just like a
    // relative `/p/...` link, not kept clickable as if it were external.
    const ownOrigin = `${window.location.origin}/p/abc`;
    const html = renderChatMarkdown(`[x](${ownOrigin})`, {
      neutralizeInternalLinks: true,
    });
    const a = firstAnchor(html);
    expect(a).not.toBeNull();
    expect(a!.hasAttribute("href")).toBe(false);
    expect(a!.hasAttribute("target")).toBe(false);
    expect(a!.textContent).toBe("x");
  });

  it("neutralizes dangerous/unsafe schemes when the flag is ON", () => {
    // javascript:, data:, and protocol-relative `//...` must never stay
    // clickable on the anonymous share — they are not genuinely external
    // http(s) links to a different host, so the href is dropped (or sanitized
    // away entirely by DOMPurify).
    for (const markdown of [
      "[a](javascript:alert(1))",
      "[b](data:text/html,<script>alert(1)</script>)",
      "[c](//evil.com/x)",
    ]) {
      const html = renderChatMarkdown(markdown, {
        neutralizeInternalLinks: true,
      });
      const a = firstAnchor(html);
      // Either the anchor was stripped of its href, or DOMPurify removed the
      // unsafe href outright; in both cases nothing dangerous remains.
      if (a !== null) {
        expect(a.hasAttribute("href")).toBe(false);
        expect(a.hasAttribute("target")).toBe(false);
      }
    }
  });

  it("keeps internal links clickable when the flag is OFF (internal default)", () => {
    const html = renderChatMarkdown("[x](/p/abc)");
    const a = firstAnchor(html);
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("/p/abc");
  });

  it("keeps an absolute own-origin link clickable when the flag is OFF (internal default)", () => {
    const ownOrigin = `${window.location.origin}/p/abc`;
    const html = renderChatMarkdown(`[x](${ownOrigin})`);
    const a = firstAnchor(html);
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe(ownOrigin);
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
