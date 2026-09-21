import { memo, useMemo } from "react";
import { splitPlainChunks } from "@/features/ai-chat/components/streaming-plain-text.tsx";
import { renderChatMarkdown } from "@/features/ai-chat/utils/markdown.ts";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

/**
 * One STABILIZED markdown block, rendered through the canonical pipeline and
 * memoized on its string prop. During streaming only the TAIL chunk grows (the
 * `splitPlainChunks` append-only invariant guarantees every earlier chunk is
 * byte-identical across deltas), so React skips every stable block and each one
 * is parsed by `renderChatMarkdown` EXACTLY ONCE — turning the pre-#492
 * "re-parse the whole accumulated answer on every ~20Hz tick" (O(ticks)) into
 * O(number of blocks). The markup is DOMPurify-sanitized inside renderChatMarkdown
 * before it reaches `dangerouslySetInnerHTML`.
 *
 * NOTE (transient streaming-only artifact): a safe cut is a blank-line boundary,
 * so a construct that legitimately contains a blank line (e.g. a fenced code block
 * with an empty line) can be split across chunks and render oddly WHILE it is still
 * streaming. This is cosmetic and self-heals: the moment the part finalizes,
 * MarkdownPart renders the WHOLE text through one canonical pass (visual parity
 * with the pre-#492 output). The reasoning path makes the same trade (plain text
 * while streaming, one markdown parse at the end).
 */
const MarkdownChunk = memo(function MarkdownChunk({
  text,
  neutralizeInternalLinks,
}: {
  text: string;
  neutralizeInternalLinks: boolean;
}) {
  const html = renderChatMarkdown(text, { neutralizeInternalLinks });
  if (html) {
    return (
      <div
        className={classes.markdown}
        // Sanitized by renderChatMarkdown (DOMPurify) before insertion.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  // Malformed/unsupported markdown could not render synchronously: raw text.
  return (
    <div className={classes.markdown} style={{ whiteSpace: "pre-wrap" }}>
      {text}
    </div>
  );
});

/**
 * The cheap streaming-time stand-in for the finalized answer's one-time markdown
 * parse (see MarkdownPart in message-item.tsx). Mirrors StreamingPlainText's
 * chunked-memo pattern but renders the STABILIZED prefix as real markdown (each
 * block parsed once, memoized) and only the LIVE tail as flat plain text — so the
 * user sees formatted output for everything up to the last safe cut, and the not-
 * yet-stable tail (which markdown-parsing every tick would make O(ticks)) stays a
 * single cheap escaped text node until it stabilizes into a new block.
 *
 * `splitPlainChunks` yields chunks where, under append-only growth, every chunk
 * except the LAST is immutable; the last chunk is the live tail. Index keys are
 * therefore stable (a given index never changes to a different chunk's content).
 */
export function StreamingMarkdownText({
  text,
  neutralizeInternalLinks,
}: {
  text: string;
  neutralizeInternalLinks: boolean;
}) {
  const chunks = useMemo(() => splitPlainChunks(text), [text]);
  return (
    <>
      {chunks.map((chunk, index) =>
        index < chunks.length - 1 ? (
          <MarkdownChunk
            key={index}
            text={chunk}
            neutralizeInternalLinks={neutralizeInternalLinks}
          />
        ) : (
          // The live tail: flat, React-escaped plain text (no markdown parse, no
          // sanitizer, no innerHTML). `pre-wrap` preserves its newlines; trailing
          // separator newlines are dropped at display time so the block gap comes
          // from the markdown margins, not a doubled empty line (mirrors
          // PlainChunk in streaming-plain-text.tsx).
          <div
            key={index}
            className={classes.markdown}
            style={{ whiteSpace: "pre-wrap" }}
          >
            {chunk.replace(/\n+$/, "")}
          </div>
        ),
      )}
    </>
  );
}
