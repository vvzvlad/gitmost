import { memo, useMemo } from "react";

/**
 * Split plain text into chunks at blank-line (paragraph) boundaries, keeping
 * each separator run attached to the END of the preceding chunk, so the chunks
 * always reassemble byte-for-byte into the input.
 *
 * A boundary is the end of a maximal `\n{2,}` run that is followed by at least
 * one more character. A newline run that is a SUFFIX of the text is NOT a
 * boundary yet: under append-only growth it may still gain more newlines, and
 * cutting there would move the boundary on the next call.
 *
 * CRITICAL INVARIANT (load-bearing for StreamingPlainText's memoization): for
 * APPEND-ONLY growth of `text`, every chunk except the LAST is byte-identical
 * between successive calls — previously-emitted boundaries never move. Proof
 * sketch: appending never modifies existing characters, so (a) an existing
 * boundary's newline run and its following character are untouched and the
 * boundary persists at the same offset; (b) no NEW boundary can appear strictly
 * inside the old text, because a `\n{2,}` run followed by a character entirely
 * within the old text would already have been a boundary. New boundaries can
 * only materialize at or after the old text's end, i.e. inside the last chunk.
 *
 * CRLF is deliberately NOT a boundary: supporting `(?:\r?\n){2,}` would BREAK
 * the invariant above — a lone trailing `\r` is not a boundary, but a later-
 * appended `\n` would merge with it into a new separator unit and retroactively
 * create a boundary INSIDE previously-emitted text, moving old chunk edges.
 * With `\n`-only runs, appended characters can never extend a run that is
 * already followed by a non-`\n` character, so old boundaries are immutable.
 * CRLF blank lines therefore intentionally stay inside one chunk: correctness/
 * losslessness are unaffected, only chunk granularity for CRLF input (LLM
 * output is `\n` in practice).
 */
export function splitPlainChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/\n{2,}/g)) {
    const end = match.index + match[0].length;
    // Suffix run: not a stable boundary yet (see the invariant above).
    if (end >= text.length) break;
    chunks.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}

/**
 * One immutable chunk. Memoized on its string prop: during streaming only the
 * TAIL chunk's text changes (see the splitPlainChunks invariant), so React
 * skips every stable chunk and the per-delta DOM work is a single text-node
 * update. `pre-wrap` is set per chunk (like the old raw-text fallback did), NOT
 * on the surrounding markdown-styled container — see the note in
 * ai-chat.module.css. Font/size/color are inherited from that container.
 *
 * DISPLAY-ONLY newline strip: the raw chunk keeps its trailing `\n{2,}`
 * separator run attached (the splitPlainChunks invariant, load-bearing for the
 * memo), but rendering those newlines inside a pre-wrap block would add an
 * empty line ON TOP of the block break — a doubled gap. So the RENDERED string
 * drops trailing newlines and the paragraph gap comes from `marginBottom: 4`
 * instead, matching the `.reasoningText p { margin: 0 0 4px }` rhythm of the
 * finalized markdown. Multi-blank-line runs thus collapse to one uniform gap,
 * consistent with `collapseBlankLines` on the markdown path. The last chunk
 * usually has no trailing newlines (strip is a no-op); its margin is harmless.
 */
const PlainChunk = memo(function PlainChunk({ text }: { text: string }) {
  return (
    <div style={{ whiteSpace: "pre-wrap", marginBottom: 4 }}>
      {text.replace(/\n+$/, "")}
    </div>
  );
});

/**
 * Renders still-streaming plain text as a list of paragraph chunks where only
 * the tail chunk changes per delta. No markdown, no sanitizer, no innerHTML —
 * this is the cheap streaming-time stand-in for the one-time markdown parse
 * that happens after the part is finalized (see reasoning-block.tsx).
 */
export function StreamingPlainText({ text }: { text: string }) {
  const chunks = useMemo(() => splitPlainChunks(text), [text]);
  return (
    <>
      {chunks.map((chunk, index) => (
        // Index keys are stable here: chunks are append-only (the invariant),
        // so an index never gets a different chunk's content mid-stream.
        <PlainChunk key={index} text={chunk} />
      ))}
    </>
  );
}
