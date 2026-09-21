/**
 * Token-degeneration detector for the in-app agent stream (#444).
 *
 * When the final-step lockdown is OFF (the new default) there is no toolChoice
 * override to strip the model's tools mid-work, so the anti-babble safety net is
 * this detector. It watches the accumulating assistant text and, on a runaway
 * repetition loop (the 255KB "loadTools." incident), aborts the run.
 *
 * Both rules are PURE functions of the text tail so they are cheap to run every
 * few KB and are unit-testable in isolation. They operate on the TAIL only
 * (`TAIL_WINDOW` chars) so the cost is bounded regardless of how long the turn is.
 */

/** How many trailing chars of the accumulated text the rules inspect. */
export const TAIL_WINDOW = 3000;

/** Rule 1 threshold: minimum consecutive identical non-empty lines to trigger. */
export const REPEATED_LINES_THRESHOLD = 25;

/** Rule 2: maximum length of a repeating block considered for periodicity. */
export const MAX_PERIOD_LEN = 150;

/** Rule 2: minimum number of consecutive block repeats to trigger. */
export const MIN_PERIOD_REPEATS = 20;

/**
 * Read a positive-integer threshold from an env var, falling back to `fallback`
 * on unset/blank/invalid/non-positive. Mirrors the `AI_STREAM_PRE_RESPONSE_RETRIES`
 * resolver in `ai-streaming-fetch.ts`: read the RAW string first so a blank value
 * is treated as "unset" (→ fallback) rather than coercing to 0. Thresholds must
 * stay ≥ 1 — a 0/negative would make the detector fire on any text (or never), so
 * a bad value degrades to the safe compiled default instead. Env-tunable so an
 * operator can retune the anti-babble guard (#444) without a redeploy, following
 * the `AI_CHAT_FINAL_STEP_LOCKDOWN` toggle convention.
 */
function envThreshold(name: string, fallback: number): number {
  const rawStr = process.env[name];
  if (rawStr === undefined || rawStr.trim() === '') return fallback;
  const raw = Number(rawStr);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallback;
}

/**
 * Resolve the degeneration-detector thresholds from the environment, each
 * defaulting to the compiled constant above. Read fresh per call (not cached at
 * import) so a test — or a runtime env change — takes effect deterministically.
 */
export function degenerationThresholds(): {
  repeatedLines: number;
  maxPeriodLen: number;
  minPeriodRepeats: number;
  checkStep: number;
} {
  return {
    repeatedLines: envThreshold(
      'AI_CHAT_DEGENERATION_REPEATED_LINES',
      REPEATED_LINES_THRESHOLD,
    ),
    maxPeriodLen: envThreshold(
      'AI_CHAT_DEGENERATION_PERIOD_MAX_LEN',
      MAX_PERIOD_LEN,
    ),
    minPeriodRepeats: envThreshold(
      'AI_CHAT_DEGENERATION_PERIOD_MIN_REPEATS',
      MIN_PERIOD_REPEATS,
    ),
    checkStep: envThreshold(
      'AI_CHAT_DEGENERATION_CHECK_STEP',
      DEGENERATION_CHECK_STEP,
    ),
  };
}

/**
 * Rule 1 — ≥`REPEATED_LINES_THRESHOLD` consecutive IDENTICAL non-empty lines at
 * the tail. Catches the classic newline-delimited loop ("loadTools.\n" ×N).
 * Blank lines break a run (a table / list with blank separators never trips it);
 * a run of ordinary distinct lines (an edit list, code) never reaches the count.
 *
 * NB: `REPEATED_LINES_THRESHOLD` (25) is only THIS rule's own trigger, not the
 * effective floor for detecting a repeated-line loop. In practice a newline-
 * delimited repeat also has a fixed period (line + '\n'), so rule 2 catches it
 * via periodicity at `MIN_PERIOD_REPEATS` (20) repeats — the two rules combine
 * (see `isDegenerateOutput`), so the effective lower bound for a short identical
 * line loop is ~20, not 25. Pure.
 */
export function hasRepeatedLineRun(
  text: string,
  threshold = REPEATED_LINES_THRESHOLD,
): boolean {
  const tail = text.length > TAIL_WINDOW ? text.slice(-TAIL_WINDOW) : text;
  const lines = tail.split('\n');
  let run = 1;
  let prev: string | null = null;
  for (const line of lines) {
    if (line.length > 0 && line === prev) {
      run += 1;
      if (run >= threshold) return true;
    } else {
      run = 1;
    }
    prev = line;
  }
  return false;
}

/**
 * Rule 2 — cheap suffix-periodicity check: the tail ends in
 * ≥`MIN_PERIOD_REPEATS` back-to-back repeats of a single block of length
 * ≤`MAX_PERIOD_LEN`. Catches a no-newline repeat ("abcabcabc…") the line rule
 * misses. For each candidate period length p we verify the last `repeats*p`
 * chars are p-periodic; we stop at the smallest p that satisfies the repeat
 * count. Bounded by MAX_PERIOD_LEN × TAIL_WINDOW comparisons — negligible. Pure.
 */
export function hasPeriodicTail(
  text: string,
  maxPeriod = MAX_PERIOD_LEN,
  minRepeats = MIN_PERIOD_REPEATS,
): boolean {
  const tail = text.length > TAIL_WINDOW ? text.slice(-TAIL_WINDOW) : text;
  const n = tail.length;
  // Not even the shortest possible loop fits in the tail.
  if (n < minRepeats) return false;
  // A tail of ONE repeated char (a "trivial period") is common in LEGIT output —
  // markdown rules (----/====), setext underlines, box-drawing dividers,
  // trailing spaces routinely produce 20–50 identical chars. Such a run is
  // p-periodic for EVERY p, so it would otherwise trip the block rule at p>=2
  // too, not just p===1. We therefore split the check: a monochar tail needs far
  // more repeats (a real single-char babble loop produces hundreds-to-thousands;
  // 60 is well above any realistic divider yet a fifth of TAIL_WINDOW), while a
  // genuine multi-char block repeat (>=2 distinct chars, e.g. the "loadTools."
  // incident, period ~10) keeps the normal MIN_PERIOD_REPEATS threshold.
  const TRIVIAL_MIN_REPEATS = 60;

  // Monochar-tail check (the trivial-period case): count the trailing run of one
  // identical char and require TRIVIAL_MIN_REPEATS of them.
  {
    const last = tail[n - 1];
    let run = 1;
    for (let i = n - 2; i >= 0 && tail[i] === last; i--) run++;
    if (run >= TRIVIAL_MIN_REPEATS) return true;
  }

  const maxP = maxPeriod;
  for (let p = 2; p <= maxP; p++) {
    // Verify the last (minRepeats*p) chars are p-periodic AND not monochar (a
    // monochar span is the trivial case handled above, so skip it here to avoid
    // re-flagging a legit divider at a composite period).
    const span = minRepeats * p;
    // Not enough tail to hold this many repeats of this period.
    if (span > n) continue;
    const start = n - span;
    let periodic = true;
    let multiChar = false;
    for (let i = n - 1; i >= start + p; i--) {
      if (tail[i] !== tail[i - p]) {
        periodic = false;
        break;
      }
    }
    if (!periodic) continue;
    // Confirm the block itself has >=2 distinct chars (else it's monochar).
    for (let i = start + 1; i < n; i++) {
      if (tail[i] !== tail[start]) {
        multiChar = true;
        break;
      }
    }
    if (multiChar) return true;
  }
  return false;
}

/**
 * Combined guard used by the stream's onChunk: true when EITHER rule fires.
 * Pure — the caller owns the abort side effect.
 */
export function isDegenerateOutput(text: string): boolean {
  const cfg = degenerationThresholds();
  return (
    hasRepeatedLineRun(text, cfg.repeatedLines) ||
    hasPeriodicTail(text, cfg.maxPeriodLen, cfg.minPeriodRepeats)
  );
}

/**
 * How many bytes the in-progress text must grow before the (amortized) tail
 * heuristics are re-run. Shared with ai-chat.service so the throttle the stream
 * applies is the SAME one the unit test drives.
 */
export const DEGENERATION_CHECK_STEP = 2000;

/**
 * Throttle decision for the degeneration guard (#444/#486). Returns true when
 * the accumulated text has grown at least DEGENERATION_CHECK_STEP bytes past the
 * last-checked offset, so the pure rules only fire every ~2KB. Pure; the caller
 * updates its watermark to `textLen` when this returns true.
 *
 * The watermark is an offset INTO the accumulator, so when the accumulator is
 * reset to '' on a step boundary the caller MUST reset the watermark to 0 too
 * (#486). Otherwise `textLen - lastCheckLen` goes negative after the reset and
 * this returns false until a later step re-grows past the stale offset — a whole
 * degenerate step could stream unchecked.
 */
export function shouldCheckDegeneration(
  textLen: number,
  lastCheckLen: number,
): boolean {
  return textLen - lastCheckLen >= degenerationThresholds().checkStep;
}

/**
 * Truncate a degenerated tail before persist so hundreds of KB of garbage never
 * reach the DB / replay (#444). Keeps everything up to and including the FIRST
 * `keepRepeats` repeats of the detected loop, then appends a short marker. If no
 * loop is detected the text is returned unchanged (by identity).
 *
 * Implementation: find the shortest tail period (same check as hasPeriodicTail),
 * keep the prefix before the loop plus `keepRepeats` copies of the block, drop
 * the rest. This is best-effort cosmetic trimming; correctness does not depend on
 * finding the exact minimal loop. Pure.
 */
export function truncateDegeneratedTail(
  text: string,
  keepRepeats = 3,
): string {
  const marker = '\n…[output truncated: repeated token loop detected]';
  // Try the line rule first: collapse a long run of identical lines.
  const lines = text.split('\n');
  let runStart = -1;
  let run = 1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].length > 0 && lines[i] === lines[i - 1]) {
      if (run === 1) runStart = i - 1;
      run += 1;
      if (run >= REPEATED_LINES_THRESHOLD) {
        const kept = lines.slice(0, runStart + keepRepeats).join('\n');
        return kept + marker;
      }
    } else {
      run = 1;
      runStart = -1;
    }
  }

  // Fall back to periodicity over the whole string (bounded by the same block
  // length). Find the smallest period that makes the SUFFIX highly repetitive.
  const n = text.length;
  const maxP = Math.min(MAX_PERIOD_LEN, Math.floor(n / MIN_PERIOD_REPEATS));
  for (let p = 1; p <= maxP; p++) {
    // Count how many trailing p-blocks are periodic.
    let reps = 1;
    let i = n - 1;
    for (; i >= p; i--) {
      if (text[i] !== text[i - p]) break;
    }
    // The loop above walks over the periodic suffix; its length is (n-1 - i).
    const periodicLen = n - 1 - i;
    reps = Math.floor(periodicLen / p) + 1;
    if (reps >= MIN_PERIOD_REPEATS) {
      const loopStart = n - reps * p; // start of the fully-periodic suffix
      const kept = text.slice(0, loopStart + keepRepeats * p);
      return kept + marker;
    }
  }
  return text;
}
