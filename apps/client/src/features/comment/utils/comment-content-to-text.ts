/**
 * Flatten a comment's ProseMirror JSON document to plain text.
 *
 * `IComment.content` is stored as a stringified ProseMirror doc, but this also
 * accepts an already-parsed object. Walks the node tree, concatenating `text`
 * leaves and joining text-bearing blocks with newlines. Missing, empty or
 * malformed content yields an empty string (never throws).
 */
export function commentContentToText(content: unknown): string {
  let doc: any = content;

  if (typeof content === "string") {
    const trimmed = content.trim();
    if (!trimmed) return "";
    try {
      doc = JSON.parse(trimmed);
    } catch {
      // Not JSON — fall back to treating the raw string as plain text.
      return trimmed;
    }
  }

  if (!doc || typeof doc !== "object") return "";

  const blocks: string[] = [];

  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;

    if (typeof node.text === "string") {
      // Inline text leaf: append to the current block line.
      if (blocks.length === 0) blocks.push("");
      blocks[blocks.length - 1] += node.text;
      return;
    }

    if (node.type === "hardBreak") {
      // A soft line break inside a block: keep the newline so the two halves
      // do not run together.
      if (blocks.length === 0) blocks.push("");
      blocks[blocks.length - 1] += "\n";
      return;
    }

    const children = Array.isArray(node.content) ? node.content : [];
    const containsText = children.some(
      (child: any) =>
        child && typeof child === "object" && typeof child.text === "string",
    );

    if (containsText) {
      // Text-bearing block (paragraph, heading, ...): start a fresh line, then
      // collect its inline text.
      blocks.push("");
      children.forEach(walk);
      return;
    }

    // Structural container (doc, list, blockquote, ...): recurse so each nested
    // text block becomes its own line.
    children.forEach(walk);
  };

  walk(doc);

  return blocks
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .join("\n")
    .trim();
}
