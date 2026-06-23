import { describe, it, expect } from "vitest";
import {
  getEmbedUrlAndProvider,
  getEmbedProviderById,
  embedProviders,
} from "./embed-provider";

// Contract tests for the embed providers (embed-provider.ts). `getEmbedUrlAndProvider`
// matches a pasted URL against an ordered list of provider regexes and rewrites it
// to the provider's canonical embeddable URL; if nothing matches it falls back to a
// raw iframe. Each provider has a share-URL -> embed-URL contract plus passthrough
// for already-embedded URLs. A regression here means an embed silently renders the
// wrong thing or an unsupported provider, so we pin all 11 providers.

describe("getEmbedProviderById", () => {
  it("looks providers up case-insensitively by id", () => {
    expect(getEmbedProviderById("youtube")?.name).toBe("YouTube");
    expect(getEmbedProviderById("YOUTUBE")?.name).toBe("YouTube");
    expect(getEmbedProviderById("gdrive")?.name).toBe("Google Drive");
  });

  it("returns undefined for an unknown id", () => {
    expect(getEmbedProviderById("notaprovider")).toBeUndefined();
  });

  it("registers exactly 11 providers", () => {
    expect(embedProviders).toHaveLength(11);
  });
});

describe("getEmbedUrlAndProvider", () => {
  describe("YouTube", () => {
    it("rewrites watch?v / youtu.be / m. / music. to youtube-nocookie embeds", () => {
      const expected = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
      for (const url of [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtu.be/dQw4w9WgXcQ",
        "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      ]) {
        expect(getEmbedUrlAndProvider(url)).toEqual({
          provider: "youtube",
          embedUrl: expected,
        });
      }
    });

    it("passes an already-/embed/ URL through unchanged", () => {
      const url = "https://www.youtube.com/embed/dQw4w9WgXcQ";
      expect(getEmbedUrlAndProvider(url)).toEqual({
        provider: "youtube",
        embedUrl: url,
      });
    });
  });

  describe("Vimeo", () => {
    it("extracts the numeric video id from channel/group/album/plain URLs", () => {
      expect(getEmbedUrlAndProvider("https://vimeo.com/123456789").embedUrl).toBe(
        "https://player.vimeo.com/video/123456789",
      );
      expect(
        getEmbedUrlAndProvider(
          "https://vimeo.com/channels/staffpicks/123456789",
        ).embedUrl,
      ).toBe("https://player.vimeo.com/video/123456789");
      expect(
        getEmbedUrlAndProvider("https://vimeo.com/groups/name/videos/123456789")
          .embedUrl,
      ).toBe("https://player.vimeo.com/video/123456789");
      expect(
        getEmbedUrlAndProvider("https://vimeo.com/album/123/video/456789")
          .embedUrl,
      ).toBe("https://player.vimeo.com/video/456789");
    });
  });

  describe("Loom", () => {
    it("rewrites /share/ to /embed/", () => {
      expect(getEmbedUrlAndProvider("https://loom.com/share/abc123")).toEqual({
        provider: "loom",
        embedUrl: "https://loom.com/embed/abc123",
      });
    });

    it("passes an already-/embed/ URL through", () => {
      const url = "https://loom.com/embed/abc123";
      expect(getEmbedUrlAndProvider(url).embedUrl).toBe(url);
    });
  });

  describe("Airtable", () => {
    it("rewrites a share URL to an /embed/ URL", () => {
      expect(
        getEmbedUrlAndProvider("https://airtable.com/shrABC123/tblXYZ").embedUrl,
      ).toBe("https://airtable.com/embed/shrABC123/tblXYZ");
    });

    it("passes an already-/embed/ URL through", () => {
      const url = "https://airtable.com/embed/shrABC123";
      expect(getEmbedUrlAndProvider(url).embedUrl).toBe(url);
    });
  });

  describe("Miro", () => {
    it("rewrites /app/board/ to a /app/live-embed/ URL", () => {
      const res = getEmbedUrlAndProvider("https://miro.com/app/board/uXjVABC=");
      expect(res.provider).toBe("miro");
      expect(res.embedUrl).toContain("https://miro.com/app/live-embed/uXjVABC=");
    });

    it("passes an already-/live-embed/ URL through", () => {
      const url = "https://miro.com/app/live-embed/uXjVABC=?embedMode=view_only";
      expect(getEmbedUrlAndProvider(url).embedUrl).toBe(url);
    });
  });

  describe("Figma", () => {
    it("wraps the file URL in the figma embed host (id length 22..128)", () => {
      const id22 = "a".repeat(22);
      const id128 = "b".repeat(128);
      const url22 = `https://www.figma.com/file/${id22}/Design`;
      const url128 = `https://www.figma.com/design/${id128}/Design`;
      expect(getEmbedUrlAndProvider(url22).embedUrl).toBe(
        `https://www.figma.com/embed?url=${url22}&embed_host=docmost`,
      );
      expect(getEmbedUrlAndProvider(url128).provider).toBe("figma");
    });

    it("does NOT match a too-short id (< 22 chars) -> iframe fallback", () => {
      const url = `https://www.figma.com/file/${"a".repeat(10)}/Design`;
      expect(getEmbedUrlAndProvider(url).provider).toBe("iframe");
    });
  });

  describe("Google Drive / Sheets", () => {
    it("rewrites a gdrive file URL to /preview using the id (match[4])", () => {
      expect(
        getEmbedUrlAndProvider("https://drive.google.com/file/d/1AbC_dEf-Gh/view")
          .embedUrl,
      ).toBe("https://drive.google.com/file/d/1AbC_dEf-Gh/preview");
    });

    it("passes a gsheets URL through unchanged", () => {
      const url = "https://docs.google.com/spreadsheets/d/1AbC_dEf-Gh/edit";
      expect(getEmbedUrlAndProvider(url)).toEqual({
        provider: "google sheets",
        embedUrl: url,
      });
    });
  });

  describe("Typeform / Framer (passthrough providers)", () => {
    it("passes typeform and framer URLs through unchanged", () => {
      const tf = "https://my.typeform.com/to/abc123";
      expect(getEmbedUrlAndProvider(tf)).toEqual({
        provider: "typeform",
        embedUrl: tf,
      });
      const framer = "https://www.framer.com/embed/foo-bar";
      expect(getEmbedUrlAndProvider(framer)).toEqual({
        provider: "framer",
        embedUrl: framer,
      });
    });
  });

  describe("fallback", () => {
    it("returns the raw iframe provider for an unknown URL", () => {
      const url = "https://example.com/some/random/page";
      expect(getEmbedUrlAndProvider(url)).toEqual({
        provider: "iframe",
        embedUrl: url,
      });
    });

    it("returns iframe for junk / non-URL input", () => {
      expect(getEmbedUrlAndProvider("not a url at all")).toEqual({
        provider: "iframe",
        embedUrl: "not a url at all",
      });
    });
  });
});
