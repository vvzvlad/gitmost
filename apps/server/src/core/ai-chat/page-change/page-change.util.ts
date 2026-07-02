import { createTwoFilesPatch } from 'diff';

/**
 * Per-turn page-change detection (#274).
 *
 * The agent rebuilds its context from the DB each turn and does not otherwise
 * know that the user hand-edited the open page since its last response. This
 * pure helper diffs the Markdown snapshot taken at the END of the agent's
 * previous turn against the page's CURRENT Markdown, yielding exactly what a
 * human changed in between (the agent's own edits are baked into the snapshot).
 * The caller surfaces the diff as an ephemeral note in the system prompt.
 *
 * Both ends are produced by the SAME renderer (exportPageMarkdown), so pure
 * formatting never pollutes the diff. We additionally normalize whitespace here
 * so trailing-space / blank-line churn between two renders does not register as a
 * change.
 */

// Upper bound on the emitted diff. Kept in the ~4–8 KB band: large enough to
// carry a substantial human edit, small enough that a wholesale rewrite of a big
// page can't blow up the system prompt. On overflow the diff is cut here and the
// model is told to read the full current page via the getPage tool instead.
const DIFF_SIZE_CAP = 6000;

const TRUNCATION_HINT =
  '\n... diff truncated — use getPage to read the full current page.';

/**
 * Normalize a rendered Markdown blob so only meaningful content differences
 * survive: unify line endings, strip trailing whitespace on every line, and drop
 * leading/trailing blank lines. Two renders that differ only in whitespace
 * normalize to the SAME string, so `computePageChange` reports no change.
 */
export function normalizeMarkdown(md: string): string {
  return (md ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

export interface PageChange {
  changed: boolean;
  diff: string;
}

/**
 * Compute the between-turns page change. Returns `{ changed:false, diff:'' }`
 * when the two renders are identical after whitespace normalization (the common
 * case, and the whitespace-only case). Otherwise returns a unified Markdown diff,
 * capped at DIFF_SIZE_CAP with a hint pointing the model at getPage.
 */
export function computePageChange(
  snapshotMd: string,
  currentMd: string,
): PageChange {
  const before = normalizeMarkdown(snapshotMd);
  const after = normalizeMarkdown(currentMd);

  if (before === after) {
    return { changed: false, diff: '' };
  }

  // createTwoFilesPatch emits a standard unified diff (---/+++ headers + @@
  // hunks). The filenames double as human-readable labels for the two ends.
  const patch = createTwoFilesPatch(
    'page (agent snapshot)',
    'page (current)',
    before,
    after,
    '',
    '',
    { context: 3 },
  );

  const diff =
    patch.length > DIFF_SIZE_CAP
      ? patch.slice(0, DIFF_SIZE_CAP) + TRUNCATION_HINT
      : patch;

  return { changed: true, diff };
}
