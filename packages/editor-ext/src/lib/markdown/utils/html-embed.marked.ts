import { Token } from "marked";

interface HtmlEmbedToken {
  type: "htmlEmbed";
  raw: string;
  encoded: string;
}

/**
 * Marked extension that rebuilds an `htmlEmbed` node from the HTML comment
 * marker produced by the turndown rule (`<!--html-embed:<base64>-->`).
 *
 * It emits the same marker div the node's `parseHTML` recognizes, so the
 * pipeline MD -> HTML -> ProseMirror JSON restores the node (and its
 * base64 `data-source`) exactly. We do NOT expand the raw markup here; the
 * source stays base64-encoded in the attribute and is only executed by the
 * client NodeView.
 */
export const htmlEmbedExtension = {
  name: "htmlEmbed",
  level: "block" as const,
  start(src: string) {
    return src.indexOf("<!--html-embed:");
  },
  tokenizer(src: string): HtmlEmbedToken | undefined {
    const rule = /^<!--html-embed:([A-Za-z0-9+/=]*)-->/;
    const match = rule.exec(src);

    if (match) {
      return {
        type: "htmlEmbed",
        raw: match[0],
        encoded: match[1] ?? "",
      };
    }
  },
  renderer(token: Token) {
    const htmlEmbedToken = token as HtmlEmbedToken;
    return `<div data-type="htmlEmbed" data-source="${htmlEmbedToken.encoded}"></div>`;
  },
};
