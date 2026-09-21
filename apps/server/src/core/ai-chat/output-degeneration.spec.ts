import { Logger } from '@nestjs/common';
import { streamText } from 'ai';
import {
  hasRepeatedLineRun,
  hasPeriodicTail,
  isDegenerateOutput,
  truncateDegeneratedTail,
  shouldCheckDegeneration,
  DEGENERATION_CHECK_STEP,
  REPEATED_LINES_THRESHOLD,
  MIN_PERIOD_REPEATS,
  degenerationThresholds,
} from './output-degeneration';
import { AiChatService } from './ai-chat.service';

// Part A (#495 iter10): the detector thresholds are env-tunable. These drive the
// resolver against real repeat-count shapes and mutation-verify that the env
// override actually changes the trigger point (not a vacuous read).
describe('degeneration thresholds are env-configurable', () => {
  const VARS = [
    'AI_CHAT_DEGENERATION_REPEATED_LINES',
    'AI_CHAT_DEGENERATION_PERIOD_MAX_LEN',
    'AI_CHAT_DEGENERATION_PERIOD_MIN_REPEATS',
    'AI_CHAT_DEGENERATION_CHECK_STEP',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const v of VARS) saved[v] = process.env[v];
  });
  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it('defaults to the compiled constants when unset', () => {
    for (const v of VARS) delete process.env[v];
    expect(degenerationThresholds()).toEqual({
      repeatedLines: REPEATED_LINES_THRESHOLD,
      maxPeriodLen: 150,
      minPeriodRepeats: MIN_PERIOD_REPEATS,
      checkStep: DEGENERATION_CHECK_STEP,
    });
  });

  it('falls back to the default on blank / invalid / non-positive values', () => {
    for (const bad of ['', '  ', 'abc', '0', '-3', '1.5']) {
      process.env.AI_CHAT_DEGENERATION_REPEATED_LINES = bad;
      // '1.5' floors to 1 (still ≥1, valid); every other bad value → default.
      const expected = bad === '1.5' ? 1 : REPEATED_LINES_THRESHOLD;
      expect(degenerationThresholds().repeatedLines).toBe(expected);
    }
  });

  it('a RAISED check-step suppresses a burst the default would have flagged', () => {
    // A ~3.3KB periodic burst is periodic-degenerate, but shouldCheckDegeneration
    // is the throttle gate. Default checkStep=2000 arms on it; raising the step
    // above the burst size means the throttle never re-fires for it.
    const burstLen = 'loadTools.\n'.repeat(300).length; // ~3300
    delete process.env.AI_CHAT_DEGENERATION_CHECK_STEP;
    expect(shouldCheckDegeneration(burstLen, 0)).toBe(true); // default 2000
    process.env.AI_CHAT_DEGENERATION_CHECK_STEP = String(burstLen + 1);
    expect(shouldCheckDegeneration(burstLen, 0)).toBe(false); // raised gate
  });

  it('a LOWERED repeated-lines threshold trips on a shorter identical-line run', () => {
    // 8 identical lines: below the default 25 (rule 1) and below the periodic
    // rule's 20 repeats — so isDegenerateOutput is false by default.
    const shortRun = 'x\n'.repeat(8);
    delete process.env.AI_CHAT_DEGENERATION_REPEATED_LINES;
    expect(isDegenerateOutput(shortRun)).toBe(false);
    // Lower rule 1 to 5 → the 8-line run now trips.
    process.env.AI_CHAT_DEGENERATION_REPEATED_LINES = '5';
    expect(isDegenerateOutput(shortRun)).toBe(true);
  });
});

// Mock ONLY streamText so we can capture the onChunk/onStepFinish callbacks the
// service registers and drive them by hand; every other `ai` export the service
// uses (convertToModelMessages, stepCountIs, …) stays real.
jest.mock('ai', () => {
  const actual = jest.requireActual('ai');
  return { ...actual, streamText: jest.fn() };
});

/**
 * Unit tests for the token-degeneration detector (#444) — the sole anti-babble
 * guard once the final-step lockdown is OFF. The two rules must fire on real
 * degeneration (the "loadTools." incident, a no-newline repeat) and MUST NOT fire
 * on legitimate long output (edit lists, tables, code).
 */
describe('hasRepeatedLineRun (rule 1: identical-line run)', () => {
  it('POSITIVE: fires on "loadTools.\\n" repeated many times (the incident)', () => {
    const text = 'Here is my plan.\n' + 'loadTools.\n'.repeat(300);
    expect(hasRepeatedLineRun(text)).toBe(true);
    expect(isDegenerateOutput(text)).toBe(true);
  });

  it('POSITIVE: fires at exactly the threshold', () => {
    const text = 'x\n'.repeat(REPEATED_LINES_THRESHOLD);
    expect(hasRepeatedLineRun(text)).toBe(true);
  });

  it('NEGATIVE: does NOT fire just below the threshold', () => {
    // threshold-1 identical lines followed by a distinct line.
    const text = 'x\n'.repeat(REPEATED_LINES_THRESHOLD - 1) + 'done\n';
    expect(hasRepeatedLineRun(text)).toBe(false);
  });

  it('NEGATIVE: a long edit list of DISTINCT lines never trips', () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(`- edited section ${i}: fixed typo`);
    const text = lines.join('\n');
    expect(hasRepeatedLineRun(text)).toBe(false);
    expect(isDegenerateOutput(text)).toBe(false);
  });

  it('NEGATIVE: a markdown table with blank separators does not trip', () => {
    // Repeated identical rows are unusual, but blank lines break any run.
    const block = ['| a | b |', '| - | - |', '', '| a | b |', ''];
    const text = Array.from({ length: 60 }, () => block.join('\n')).join('\n');
    expect(hasRepeatedLineRun(text)).toBe(false);
  });

  it('NEGATIVE: blank lines do NOT count toward a run', () => {
    const text = '\n'.repeat(100);
    expect(hasRepeatedLineRun(text)).toBe(false);
  });
});

describe('hasPeriodicTail (rule 2: no-newline suffix periodicity)', () => {
  it('POSITIVE: fires on a single char repeated with no newlines', () => {
    const text = 'answer: ' + 'a'.repeat(500);
    expect(hasPeriodicTail(text)).toBe(true);
    expect(isDegenerateOutput(text)).toBe(true);
  });

  it('POSITIVE: fires on a multi-char block repeat with no newlines', () => {
    const text = 'prefix ' + 'abcdef'.repeat(100);
    expect(hasPeriodicTail(text)).toBe(true);
  });

  it('POSITIVE: at least MIN_PERIOD_REPEATS repeats of a small block', () => {
    const text = 'go'.repeat(MIN_PERIOD_REPEATS);
    expect(hasPeriodicTail(text)).toBe(true);
  });

  it('NEGATIVE: prose does not look periodic', () => {
    const text =
      'The quick brown fox jumps over the lazy dog while the sun sets slowly ' +
      'behind the distant mountains and the river winds through the valley below.';
    expect(hasPeriodicTail(text)).toBe(false);
    expect(isDegenerateOutput(text)).toBe(false);
  });

  it('NEGATIVE: a long code block is not flagged', () => {
    const code = `
function compute(values) {
  let total = 0;
  for (const v of values) {
    total += v * 2;
  }
  return total / values.length;
}
export const helper = (x) => x + 1;
const config = { retries: 3, timeout: 5000, backoff: 'exp' };
`.repeat(3);
    expect(isDegenerateOutput(code)).toBe(false);
  });

  it('NEGATIVE: a short string well under the repeat count is safe', () => {
    expect(hasPeriodicTail('ababab')).toBe(false);
  });

  // Regression (#444): a trivial single-char period (p===1) must NOT flag
  // legitimate divider/underline/whitespace runs. These are common in real
  // model output and previously false-positived at ~20 identical chars, aborting
  // the run and truncating output. They must all be treated as clean.
  it('NEGATIVE: a markdown horizontal rule is not flagged', () => {
    const text = 'text\n' + '-'.repeat(40);
    expect(hasPeriodicTail(text)).toBe(false);
    expect(isDegenerateOutput(text)).toBe(false);
  });

  it('NEGATIVE: a setext heading underline is not flagged', () => {
    const text = 'Title\n' + '='.repeat(30);
    expect(hasPeriodicTail(text)).toBe(false);
    expect(isDegenerateOutput(text)).toBe(false);
  });

  it('NEGATIVE: a box-drawing divider with no trailing newline is not flagged', () => {
    const text = 'done ' + '─'.repeat(50);
    expect(hasPeriodicTail(text)).toBe(false);
    expect(isDegenerateOutput(text)).toBe(false);
  });

  it('NEGATIVE: trailing spaces are not flagged', () => {
    const text = 'answer' + ' '.repeat(40);
    expect(hasPeriodicTail(text)).toBe(false);
    expect(isDegenerateOutput(text)).toBe(false);
  });

  // TRIVIAL_MIN_REPEATS boundary (#444 review). The monochar-tail branch fires at
  // EXACTLY 60 identical trailing chars (`run >= TRIVIAL_MIN_REPEATS`), so 59 is
  // clean and 60 trips. These pin the `>=` and MUST fail if the comparison is
  // flipped to `>` (the surviving mutation). The value 60 is HARD-CODED here on
  // purpose: TRIVIAL_MIN_REPEATS is a private constant and the assert must lock
  // the literal boundary the reviewer named, not track a constant edit.
  it('NEGATIVE: 59 identical trailing chars is one below the monochar threshold', () => {
    expect(hasPeriodicTail('x'.repeat(59))).toBe(false);
    expect(isDegenerateOutput('x'.repeat(59))).toBe(false);
  });

  it('POSITIVE: 60 identical trailing chars hits the monochar threshold exactly', () => {
    // Fails if `run >= TRIVIAL_MIN_REPEATS` is mutated to `run > …`.
    expect(hasPeriodicTail('x'.repeat(60))).toBe(true);
    expect(isDegenerateOutput('x'.repeat(60))).toBe(true);
  });

  // Positive counterparts: a GENUINE single-char runaway (hundreds+ of repeats)
  // and the real incident (period>=2, "loadTools." ×N) must still fire.
  it('POSITIVE: a genuine single-char runaway is still flagged', () => {
    const text = 'x'.repeat(5000);
    expect(hasPeriodicTail(text)).toBe(true);
    expect(isDegenerateOutput(text)).toBe(true);
  });

  it('POSITIVE: the "loadTools." incident (period>=2) is still flagged', () => {
    const text = 'loadTools.'.repeat(500);
    expect(hasPeriodicTail(text)).toBe(true);
    expect(isDegenerateOutput(text)).toBe(true);
  });
});

describe('truncateDegeneratedTail', () => {
  it('collapses a repeated-line loop to a few reps + marker', () => {
    const text = 'plan\n' + 'loadTools.\n'.repeat(20000);
    const out = truncateDegeneratedTail(text);
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain('output truncated');
    // Keeps the leading context and a few loop reps.
    expect(out).toContain('plan');
    expect((out.match(/loadTools\./g) ?? []).length).toBeLessThan(10);
  });

  it('collapses a no-newline periodic loop to a few blocks + marker', () => {
    const text = 'answer: ' + 'xy'.repeat(50000);
    const out = truncateDegeneratedTail(text);
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain('output truncated');
    expect(out).toContain('answer:');
  });

  it('returns non-degenerate text unchanged (by identity)', () => {
    const text = 'A perfectly normal, finished assistant answer.';
    expect(truncateDegeneratedTail(text)).toBe(text);
  });
});

/**
 * Throttle + step-boundary reset (#486). The stream keeps a watermark
 * (`lastDegenerationCheckLen`) that is an OFFSET into the accumulated step text.
 * On a step boundary the accumulator resets to '', so the watermark MUST reset to
 * 0 too — otherwise the throttle goes silent for the whole next step. These tests
 * pin the pure decision AND the reset property that ai-chat.service.onStepFinish
 * now enforces.
 */
describe('shouldCheckDegeneration (throttle) + step-boundary reset (#486)', () => {
  it('fires once the text grows a full DEGENERATION_CHECK_STEP past the mark', () => {
    expect(shouldCheckDegeneration(DEGENERATION_CHECK_STEP, 0)).toBe(true);
    expect(shouldCheckDegeneration(DEGENERATION_CHECK_STEP - 1, 0)).toBe(false);
    expect(shouldCheckDegeneration(5000, 3000)).toBe(true); // grew 2000 since mark
    expect(shouldCheckDegeneration(4000, 3000)).toBe(false); // grew only 1000
  });

  it('BUG (no reset): a stale large watermark silences the next step', () => {
    // End of a long step: the watermark sits at 5000. The step ends and the
    // accumulator resets to '' — but if the watermark is NOT reset, a fresh short
    // degenerate burst (length 2000) never triggers a check: 2000 - 5000 < STEP.
    const staleWatermark = 5000;
    const nextStepLen = DEGENERATION_CHECK_STEP; // a fresh 2KB burst
    expect(shouldCheckDegeneration(nextStepLen, staleWatermark)).toBe(false);
  });

  it('FIX (reset to 0): the same short degenerate burst IS checked and detected', () => {
    // onStepFinish now zeroes the watermark, so the fresh burst re-arms the check.
    const resetWatermark = 0;
    const degenerateBurst = 'loadTools.\n'.repeat(300); // real degeneration
    expect(degenerateBurst.length).toBeGreaterThanOrEqual(DEGENERATION_CHECK_STEP);
    // The throttle now fires...
    expect(
      shouldCheckDegeneration(degenerateBurst.length, resetWatermark),
    ).toBe(true);
    // ...and the detector catches the loop that would otherwise stream unchecked.
    expect(isDegenerateOutput(degenerateBurst)).toBe(true);
  });
});

/**
 * BEHAVIOR guard for the ACTUAL fix (#486, ai-chat.service.onStepFinish resets
 * lastDegenerationCheckLen to 0). The pure tests above use a hard-coded
 * resetWatermark, so a REVERT of the real `lastDegenerationCheckLen = 0` line
 * would not redden any of them. This drives the REAL onChunk/onStepFinish
 * closures from stream() end to end and asserts the run is aborted when a fresh
 * degenerate burst arrives in the step AFTER a long clean step — which only
 * happens if the watermark was actually zeroed on the step boundary.
 */
describe('AiChatService: onStepFinish re-arms the degeneration watermark (#486)', () => {
  const streamTextMock = streamText as unknown as jest.Mock;

  function makeRes() {
    return {
      raw: {
        writeHead: jest.fn(),
        write: jest.fn(),
        once: jest.fn(),
        on: jest.fn(),
        flushHeaders: jest.fn(),
        writableEnded: false,
        destroyed: false,
      },
    };
  }

  function makeService() {
    const aiChatRepo = {
      findById: jest.fn(async () => ({ id: 'chat-1', workspaceId: 'ws-1' })),
      insert: jest.fn(),
    };
    const aiChatMessageRepo = {
      insert: jest.fn(async () => ({ id: 'msg-1' })),
      findAllByChat: jest.fn(async () => []),
      update: jest.fn(async () => ({ id: 'msg-1' })),
    };
    const aiSettings = { resolve: jest.fn(async () => ({})) };
    const tools = { forUser: jest.fn(async () => ({})) };
    const mcpClients = {
      toolsFor: jest.fn(async () => ({
        tools: {},
        clients: [],
        outcomes: [],
        instructions: [],
      })),
    };
    return new AiChatService(
      {} as never, // ai
      aiChatRepo as never,
      aiChatMessageRepo as never,
      {} as never, // aiChatPageSnapshotRepo
      aiSettings as never,
      tools as never,
      mcpClients as never,
      {} as never, // aiAgentRoleRepo
      {} as never, // pageRepo
      {} as never, // pageAccess
      {
        isAiChatDeferredToolsEnabled: () => false,
        // Lockdown OFF -> the degeneration guard is the active anti-babble path.
        isAiChatFinalStepLockdownEnabled: () => false,
        isAiChatViewImageEnabled: () => false,
      } as never, // environment
    );
  }

  beforeEach(() => {
    streamTextMock.mockReset();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined as never);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('aborts on a fresh degenerate burst in the NEXT step (reverting the reset line reddens this)', async () => {
    let captured:
      | {
          onChunk?: (e: { chunk: { type: string; text: string } }) => void;
          onStepFinish?: (step: unknown) => void;
          abortSignal?: AbortSignal;
        }
      | undefined;
    streamTextMock.mockImplementation((opts: never) => {
      captured = opts;
      return {
        consumeStream: jest.fn(),
        pipeUIMessageStreamToResponse: jest.fn(),
      };
    });

    const svc = makeService();
    await svc.stream({
      user: { id: 'user-1' } as never,
      workspace: { id: 'ws-1' } as never,
      sessionId: 'sess-1',
      body: {
        chatId: 'chat-1',
        messages: [
          { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        ],
      } as never,
      res: makeRes() as never,
      signal: new AbortController().signal,
      model: {} as never,
      role: null,
      // No runHooks -> legacy path (socket signal), degeneration guard active.
    });

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const onChunk = captured!.onChunk!;
    const onStepFinish = captured!.onStepFinish!;
    const abortSignal = captured!.abortSignal!;
    expect(abortSignal.aborted).toBe(false);

    // STEP 1: a LONG, non-degenerate first step. Distinct lines never trip the
    // detector, but they advance the throttle watermark far past the burst size
    // that follows (to ~5x the step). This is the stale watermark that, WITHOUT
    // the reset, would silence step 2.
    let counter = 0;
    let accumulated = 0;
    while (accumulated < DEGENERATION_CHECK_STEP * 5) {
      const line = `unique clean line number ${counter++} with distinct words\n`;
      accumulated += line.length;
      onChunk({ chunk: { type: 'text-delta', text: line } });
    }
    expect(abortSignal.aborted).toBe(false); // clean step must not abort

    // STEP BOUNDARY: the real onStepFinish resets inProgressText AND (the fix)
    // zeroes lastDegenerationCheckLen.
    onStepFinish({ text: 'a clean first step', toolCalls: [], toolResults: [] });

    // STEP 2: a FRESH, short degenerate burst (~3.3KB). Its length is far below
    // the step-1 stale watermark (~10KB), so WITHOUT the reset the throttle stays
    // silent and this streams unchecked. WITH the reset (watermark 0) it re-arms,
    // the detector fires, and the run aborts.
    const burst = 'loadTools.\n'.repeat(300);
    expect(burst.length).toBeGreaterThanOrEqual(DEGENERATION_CHECK_STEP);
    expect(burst.length).toBeLessThan(DEGENERATION_CHECK_STEP * 5);
    onChunk({ chunk: { type: 'text-delta', text: burst } });

    // The decisive assertion: the composed abortSignal (unioned with the
    // degeneration controller) is now aborted. Reverting `lastDegenerationCheckLen
    // = 0` in onStepFinish makes this stay false.
    expect(abortSignal.aborted).toBe(true);
  });
});
