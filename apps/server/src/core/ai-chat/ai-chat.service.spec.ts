import { ForbiddenException, Logger } from '@nestjs/common';
// Mock ONLY streamText so a driven stream() call can capture the pipe-options
// object (consumeSseStream / generateMessageId). Everything else in the AI SDK
// stays REAL (requireActual), so the pure-helper suites in this file are
// unaffected — none of them call stream()/streamText.
jest.mock('ai', () => ({
  ...jest.requireActual('ai'),
  streamText: jest.fn(),
}));
import { streamText } from 'ai';
import {
  AiChatService,
  compactToolOutput,
  assistantParts,
  serializeSteps,
  type StepPartsCache,
  rowToUiMessage,
  prepareAgentStep,
  stepBudgetWarning,
  flushAssistant,
  stripNulChars,
  chatStreamMetadata,
  accumulateStepUsage,
  isInterruptResume,
  sameInstant,
  MAX_AGENT_STEPS,
  STEP_BUDGET_WARNING_LEAD,
  FINAL_STEP_INSTRUCTION,
  FINAL_STEP_NUDGE,
  STEP_LIMIT_NO_ANSWER_MARKER,
  OUTPUT_DEGENERATION_ERROR,
  lastAssistantContextTokens,
  lastAssistantReplayOverflowCount,
  seedActivatedTools,
} from './ai-chat.service';
import type { AiChatMessage, Workspace } from '@docmost/db/types/entity.types';
import { buildSystemPrompt } from './ai-chat.prompt';
import type { McpClientsService } from './external-mcp/mcp-clients.service';
import {
  resolveEffectiveReplayThreshold,
  REPLAY_MIN_FLOOR_TOKENS,
} from './history-budget';

/**
 * Unit tests for compactToolOutput: the pure helper that shrinks tool outputs
 * before they are persisted (and re-sent to the provider on later turns). The
 * contract is: small and normal outputs — including whole page reads (tens of
 * KB) — pass through unchanged (by identity); only an output above the high
 * safety cap (> 200 KB) is compacted, and even then it keeps its shape and
 * small scalar fields (id/title/pageId — the client reads these to render
 * citations) while the big payloads are reduced.
 */
describe('compactToolOutput', () => {
  it('returns a small object unchanged (by identity)', () => {
    const small = { id: 'p1', title: 'Hello', trashed: true };
    expect(compactToolOutput(small)).toBe(small);
  });

  it('truncates a large getPage-shaped markdown body but keeps the title', () => {
    const big = 'x'.repeat(300000);
    const result = compactToolOutput({ title: 'T', markdown: big }) as {
      title: string;
      markdown: string;
    };
    // Shallow scalar field is preserved (citations depend on it).
    expect(result.title).toBe('T');
    // The big payload is shrunk far below the original size.
    expect(result.markdown.length).toBeLessThan(300000);
    expect(result.markdown).toContain('omitted from stored chat history');
  });

  it('caps a long array and appends a single truncation marker', () => {
    // 200 objects, each padded so the total serialized size
    // > 200000 bytes (the new safety cap).
    const long = Array.from({ length: 200 }, (_, i) => ({
      id: 'n' + i,
      pad: 'y'.repeat(1200),
    }));
    const result = compactToolOutput(long) as Array<Record<string, unknown>>;
    // 50 kept + 1 marker.
    expect(result).toHaveLength(51);
    const marker = result[result.length - 1];
    expect(marker._truncated).toBe(true);
    expect(marker.omittedItems).toBe(150);
  });

  it('passes through null, undefined and primitives unchanged', () => {
    expect(compactToolOutput(null)).toBeNull();
    expect(compactToolOutput(undefined)).toBeUndefined();
    expect(compactToolOutput(42)).toBe(42);
  });

  it('replaces a subtree beyond the depth cap with a marker', () => {
    // Build a deeply nested object (> TOOL_OUTPUT_MAX_DEPTH levels) with a big
    // string at the bottom so the total serialized size exceeds the 200 KB cap.
    let nested: Record<string, unknown> = { leaf: 'z'.repeat(250000) };
    for (let i = 0; i < 20; i++) {
      nested = { child: nested };
    }
    const result = compactToolOutput(nested);
    expect(JSON.stringify(result)).toContain('nested content omitted');
  });

  it('produces a much smaller JSON than the original for a large input', () => {
    const big = 'x'.repeat(300000);
    const original = { title: 'T', markdown: big };
    const result = compactToolOutput(original);
    const originalBytes = Buffer.byteLength(JSON.stringify(original), 'utf8');
    const compactedBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    expect(compactedBytes).toBeLessThan(originalBytes / 10);
  });
});

/**
 * Tests for assistantParts: the pure function that rebuilds the persisted
 * UIMessage parts for a turn. Its output decides whether the conversation
 * replays correctly on the next turn. The crux: a tool-call WITHOUT a paired
 * result must become a synthetic `output-error` part, so convertToModelMessages
 * never throws MissingToolResultsError. This test MUST fail on pre-fix logic
 * that persisted a bare input-available call.
 */
describe('assistantParts', () => {
  type AnyPart = Record<string, unknown>;

  // #490 memoization: assistantParts builds each step's parts once and caches
  // them by the step OBJECT's identity, so a mid-stream flush does not
  // re-stringify every prior step's (large) output. Observable property: with a
  // shared cache, the second call over the SAME step object returns the cached
  // (identical) part array even if the step's underlying output was swapped —
  // proving the work was memoized, not redone.
  it('memoizes a step by identity (shared cache => one build per step)', () => {
    const cache: StepPartsCache = new WeakMap();
    const step = {
      text: 'x',
      toolCalls: [{ toolCallId: 'c1', toolName: 'getPage', input: {} }],
      toolResults: [{ toolCallId: 'c1', toolName: 'getPage', output: { v: 1 } }],
    };
    const first = assistantParts([step], '', cache) as AnyPart[];
    expect((first.find((p) => p.type === 'tool-getPage')!.output as any).v).toBe(
      1,
    );
    // Swap the output for a NEW value; a re-build would pick it up, a cache hit
    // keeps the first result.
    step.toolResults[0] = {
      toolCallId: 'c1',
      toolName: 'getPage',
      output: { v: 2 },
    };
    const second = assistantParts([step], '', cache) as AnyPart[];
    expect((second.find((p) => p.type === 'tool-getPage')!.output as any).v).toBe(
      1,
    );
    // Same cached part objects are reused.
    expect(second.find((p) => p.type === 'tool-getPage')).toBe(
      first.find((p) => p.type === 'tool-getPage'),
    );
  });

  it('without a cache, each call rebuilds (no stale memo)', () => {
    const step = {
      text: 'x',
      toolCalls: [{ toolCallId: 'c1', toolName: 'getPage', input: {} }],
      toolResults: [{ toolCallId: 'c1', toolName: 'getPage', output: { v: 1 } }],
    };
    const first = assistantParts([step], '') as AnyPart[];
    step.toolResults[0].output = { v: 2 };
    const second = assistantParts([step], '') as AnyPart[];
    expect((second.find((p) => p.type === 'tool-getPage')!.output as any).v).toBe(
      2,
    );
  });

  it('emits output-available for a tool-call WITH a paired result', () => {
    const steps = [
      {
        text: '',
        toolCalls: [
          { toolCallId: 'c1', toolName: 'getPage', input: { id: 'p1' } },
        ],
        toolResults: [
          { toolCallId: 'c1', toolName: 'getPage', output: { title: 'T' } },
        ],
      },
    ];
    const parts = assistantParts(steps, '') as AnyPart[];
    const toolPart = parts.find((p) => p.type === 'tool-getPage');
    expect(toolPart).toBeDefined();
    expect(toolPart!.state).toBe('output-available');
    expect(toolPart!.output).toEqual({ title: 'T' });
  });

  it('emits a synthetic output-error for an UNPAIRED tool-call (crux)', () => {
    const steps = [
      {
        text: '',
        toolCalls: [
          { toolCallId: 'c9', toolName: 'insertNode', input: { node: {} } },
        ],
        toolResults: [],
      },
    ];
    const parts = assistantParts(steps, '') as AnyPart[];
    const toolPart = parts.find((p) => p.type === 'tool-insertNode');
    expect(toolPart).toBeDefined();
    // The unpaired call MUST become output-error (NOT input-available), so the
    // rebuilt history is balanced for convertToModelMessages on the next turn.
    expect(toolPart!.state).toBe('output-error');
    expect(toolPart!.errorText).toBeTruthy();
    expect(toolPart).not.toHaveProperty('output');
  });

  it('replays the REAL error text for a THROWN tool (tool-error part)', () => {
    const steps = [
      {
        text: '',
        toolCalls: [
          { toolCallId: 'c7', toolName: 'editPageText', input: { id: 'p1' } },
        ],
        // A thrown tool is a `tool-error` content part; toolResults holds only
        // successes and stays empty for this call.
        toolResults: [],
        content: [
          {
            type: 'tool-error',
            toolCallId: 'c7',
            toolName: 'editPageText',
            input: { id: 'p1' },
            error: new Error('page is locked'),
          },
        ],
      },
    ];
    const parts = assistantParts(steps, '') as AnyPart[];
    const toolPart = parts.find((p) => p.type === 'tool-editPageText');
    expect(toolPart).toBeDefined();
    expect(toolPart!.state).toBe('output-error');
    // The REAL error is replayed, NOT the 'Tool call did not complete.' placeholder.
    expect(toolPart!.errorText).toBe('page is locked');
    expect(toolPart).not.toHaveProperty('output');
  });

  it('keeps the placeholder ONLY for a call with neither result nor tool-error', () => {
    const steps = [
      {
        text: '',
        toolCalls: [
          { toolCallId: 'c8', toolName: 'insertNode', input: { node: {} } },
        ],
        toolResults: [],
        content: [], // aborted mid-step: no result AND no tool-error
      },
    ];
    const parts = assistantParts(steps, '') as AnyPart[];
    const toolPart = parts.find((p) => p.type === 'tool-insertNode');
    expect(toolPart!.state).toBe('output-error');
    expect(toolPart!.errorText).toBe('Tool call did not complete.');
  });

  it('skips malformed tool-calls (missing toolName or toolCallId)', () => {
    const steps = [
      {
        text: '',
        toolCalls: [
          { toolCallId: 'c1', input: {} }, // no toolName
          { toolName: 'getPage', input: {} }, // no toolCallId
        ],
        toolResults: [],
      },
    ];
    const parts = assistantParts(steps, '') as AnyPart[];
    const toolParts = parts.filter(
      (p) =>
        typeof p.type === 'string' && (p.type as string).startsWith('tool-'),
    );
    expect(toolParts).toHaveLength(0);
  });

  it('uses per-step text when present', () => {
    const steps = [{ text: 'hello', toolCalls: [], toolResults: [] }];
    const parts = assistantParts(steps, 'fallback-ignored') as AnyPart[];
    expect(parts).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('falls back to a single text part when no step text', () => {
    const parts = assistantParts([], 'final answer') as AnyPart[];
    expect(parts).toEqual([{ type: 'text', text: 'final answer' }]);
  });
});

// #490 trace format v2: per call the trace stores { input } for the call and an
// OUTCOME element — { ok: true } on success, { error, kind: 'thrown' } on a
// thrown tool-error, { error, kind: 'interrupted' } on a mid-step abort. The tool
// OUTPUT is no longer duplicated here (it lives once in metadata.parts).
describe('serializeSteps (trace v2)', () => {
  it('returns null when there are no calls or results', () => {
    expect(serializeSteps([])).toBeNull();
  });

  it('pairs a successful call with an { ok: true } outcome and NO output', () => {
    const trace = serializeSteps([
      {
        toolCalls: [{ toolCallId: 'c1', toolName: 'getPage', input: { id: 'p1' } }],
        toolResults: [{ toolCallId: 'c1', toolName: 'getPage' }],
      },
    ]) as Array<Record<string, unknown>>;
    expect(trace).toHaveLength(2);
    expect(trace[0]).toEqual({ toolName: 'getPage', input: { id: 'p1' } });
    expect(trace[1]).toEqual({ toolName: 'getPage', ok: true });
    // The output is NOT stored in the trace any more (dedup: it lives in parts).
    expect(trace.some((e) => 'output' in e)).toBe(false);
  });

  it('records a THROWN failure with { error, kind: "thrown" }', () => {
    const trace = serializeSteps([
      {
        toolCalls: [
          { toolCallId: 'c1', toolName: 'editPageText', input: { id: 'p1' } },
        ],
        toolResults: [],
        content: [
          {
            type: 'tool-error',
            toolCallId: 'c1',
            toolName: 'editPageText',
            error: new Error('page is locked'),
          },
        ],
      },
    ]) as Array<Record<string, unknown>>;
    expect(trace).toHaveLength(2);
    expect(trace[0]).toEqual({ toolName: 'editPageText', input: { id: 'p1' } });
    expect(trace[1]).toEqual({
      toolName: 'editPageText',
      error: 'page is locked',
      kind: 'thrown',
    });
  });

  it('marks an interrupted call (no result, no throw) with kind "interrupted"', () => {
    const trace = serializeSteps([
      {
        toolCalls: [
          { toolCallId: 'c1', toolName: 'createComment', input: { x: 1 } },
        ],
        toolResults: [],
        content: [],
      },
    ]) as Array<Record<string, unknown>>;
    expect(trace).toHaveLength(2);
    expect(trace[1]).toEqual({
      toolName: 'createComment',
      error: 'Tool call did not complete.',
      kind: 'interrupted',
    });
    // Structurally distinct from a thrown hard-fail so it never inflates an
    // error-rate scan.
    expect((trace[1] as { kind: string }).kind).not.toBe('thrown');
  });

  it('truncates a very long thrown-error message to the tool-output limit', () => {
    const long = 'x'.repeat(5000);
    const trace = serializeSteps([
      {
        toolCalls: [{ toolCallId: 'c1', toolName: 'editPageText', input: {} }],
        toolResults: [],
        content: [
          {
            type: 'tool-error',
            toolCallId: 'c1',
            toolName: 'editPageText',
            error: long,
          },
        ],
      },
    ]) as Array<Record<string, unknown>>;
    const errorText = trace[1].error as string;
    expect(errorText.length).toBeLessThan(long.length);
    expect(errorText).toContain('chars omitted');
  });

  it('pairs parallel calls in one step with their outcomes by id', () => {
    const trace = serializeSteps([
      {
        toolCalls: [
          { toolCallId: 'a', toolName: 'getPage', input: {} },
          { toolCallId: 'b', toolName: 'searchPages', input: {} },
        ],
        toolResults: [{ toolCallId: 'b', toolName: 'searchPages' }],
        content: [
          { type: 'tool-error', toolCallId: 'a', toolName: 'getPage', error: 'nope' },
        ],
      },
    ]) as Array<Record<string, unknown>>;
    // call a, outcome a (thrown), call b, outcome b (ok)
    expect(trace).toHaveLength(4);
    expect(trace[1]).toEqual({ toolName: 'getPage', error: 'nope', kind: 'thrown' });
    expect(trace[3]).toEqual({ toolName: 'searchPages', ok: true });
  });
});

// #490: every assistant row flushAssistant writes carries the v2 era marker so a
// dual-shape diagnostic query can branch on the trace shape without inspecting it.
describe('toolTraceVersion era marker (#490)', () => {
  it('stamps metadata.toolTraceVersion = 2 on every flushed row', () => {
    const seed = flushAssistant([], '', 'streaming');
    expect(seed.metadata.toolTraceVersion).toBe(2);
    const done = flushAssistant(
      [
        {
          text: 'ok',
          toolCalls: [{ toolCallId: 'c1', toolName: 'getPage', input: {} }],
          toolResults: [{ toolCallId: 'c1', toolName: 'getPage' }],
        },
      ],
      '',
      'completed',
      { finishReason: 'stop' },
    );
    expect(done.metadata.toolTraceVersion).toBe(2);
  });
});

// #490 replay-budget signal helpers over persisted history.
describe('lastAssistantContextTokens', () => {
  const row = (
    role: string,
    metadata: Record<string, unknown> | null,
  ): AiChatMessage => ({ role, metadata }) as unknown as AiChatMessage;

  it('reads the most recent assistant turn contextTokens (provider fact)', () => {
    const hist = [
      row('user', null),
      row('assistant', { contextTokens: 12000 }),
      row('user', null),
      row('assistant', { contextTokens: 41000 }),
    ];
    expect(lastAssistantContextTokens(hist)).toBe(41000);
  });

  it('returns undefined when the last assistant turn recorded no usage', () => {
    const hist = [row('assistant', { error: 'boom' }), row('user', null)];
    expect(lastAssistantContextTokens(hist)).toBeUndefined();
    expect(lastAssistantContextTokens([])).toBeUndefined();
  });
});

// #490 snapshotOpenPage fast-path: skip the full Markdown export + upsert when a
// snapshot already exists at the page's CURRENT version (same updated_at instant).
describe('snapshotOpenPage fast-path (#490)', () => {
  function makeSvc(existingSnapshot: unknown, pageUpdatedAt: Date) {
    const exportPageMarkdown = jest.fn(async () => '# md');
    const upsert = jest.fn(async () => undefined);
    const findByChatPage = jest.fn(async () => existingSnapshot);
    const pageRepo = {
      findById: jest.fn(async () => ({
        id: 'p1',
        workspaceId: 'ws1',
        updatedAt: pageUpdatedAt,
      })),
    };
    const svc = new AiChatService(
      {} as never, // ai
      {} as never, // aiChatRepo
      {} as never, // aiChatMessageRepo
      { findByChatPage, upsert } as never, // aiChatPageSnapshotRepo
      {} as never, // aiSettings
      { exportPageMarkdown } as never, // tools
      {} as never, // mcpClients
      {} as never, // aiAgentRoleRepo
      pageRepo as never, // pageRepo
      {} as never, // pageAccess
      {} as never, // environment
    );
    return { svc, exportPageMarkdown, upsert, findByChatPage };
  }

  const args = () =>
    [
      'chat1',
      'p1',
      { id: 'ws1' } as never,
      { id: 'u1' } as never,
      'sess',
    ] as const;

  it('skips export + upsert when the snapshot is already at this page version', async () => {
    const t = new Date('2026-07-07T10:00:00Z');
    const { svc, exportPageMarkdown, upsert } = makeSvc(
      { pageUpdatedAt: t, contentMd: '# md' },
      t,
    );
    await (svc as unknown as { snapshotOpenPage: (...a: unknown[]) => Promise<void> })
      .snapshotOpenPage(...args());
    expect(exportPageMarkdown).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('exports + upserts when the page advanced since the snapshot', async () => {
    const { svc, exportPageMarkdown, upsert } = makeSvc(
      { pageUpdatedAt: new Date('2026-07-07T10:00:00Z'), contentMd: 'old' },
      new Date('2026-07-07T11:00:00Z'),
    );
    await (svc as unknown as { snapshotOpenPage: (...a: unknown[]) => Promise<void> })
      .snapshotOpenPage(...args());
    expect(exportPageMarkdown).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('seeds (exports + upserts) on the first turn (no snapshot yet)', async () => {
    const { svc, exportPageMarkdown, upsert } = makeSvc(
      undefined,
      new Date('2026-07-07T10:00:00Z'),
    );
    await (svc as unknown as { snapshotOpenPage: (...a: unknown[]) => Promise<void> })
      .snapshotOpenPage(...args());
    expect(exportPageMarkdown).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

// #490 deferred-tool activation persisted across turns.
describe('seedActivatedTools', () => {
  const valid = new Set(['Search_web', 'getPageJson', 'diffPageVersions']);

  it('seeds from persisted metadata, intersected with current valid names', () => {
    expect(
      seedActivatedTools(
        { activatedTools: ['Search_web', 'getPageJson'] },
        valid,
      ),
    ).toEqual(['Search_web', 'getPageJson']);
  });

  it('drops a stored tool that is no longer valid (allowlist/role changed)', () => {
    // 'Habr_publish' was activated before but is not in the current allowlist.
    expect(
      seedActivatedTools({ activatedTools: ['Search_web', 'Habr_publish'] }, valid),
    ).toEqual(['Search_web']);
  });

  it('is empty/robust for missing, non-array, or unknown-shaped metadata', () => {
    expect(seedActivatedTools(undefined, valid)).toEqual([]);
    expect(seedActivatedTools({}, valid)).toEqual([]);
    expect(seedActivatedTools({ activatedTools: 'nope' }, valid)).toEqual([]);
    expect(
      seedActivatedTools({ activatedTools: [1, 'getPageJson', null] }, valid),
    ).toEqual(['getPageJson']);
  });

  it('de-duplicates stored names', () => {
    expect(
      seedActivatedTools(
        { activatedTools: ['getPageJson', 'getPageJson'] },
        valid,
      ),
    ).toEqual(['getPageJson']);
  });
});

describe('lastAssistantReplayOverflowCount', () => {
  const row = (
    role: string,
    metadata: Record<string, unknown> | null,
  ): AiChatMessage => ({ role, metadata }) as unknown as AiChatMessage;

  it('reads the consecutive-overflow count from the LAST assistant turn', () => {
    expect(
      lastAssistantReplayOverflowCount([
        row('assistant', { replayOverflowCount: 3 }),
        row('user', null),
      ]),
    ).toBe(3);
    // A recovered (later, non-overflow) assistant turn resets it to 0 — the read
    // stops at the most recent assistant row, which carries no count.
    expect(
      lastAssistantReplayOverflowCount([
        row('assistant', { replayOverflowCount: 3 }),
        row('user', null),
        row('assistant', { contextTokens: 5 }),
      ]),
    ).toBe(0);
    expect(lastAssistantReplayOverflowCount([])).toBe(0);
  });

  // BACK-COMPAT (#520): an in-flight row written by the pre-#520 boolean stamp
  // (`replayOverflow: true`, no count) reads as k=1 — the old single 0.5× behavior —
  // so a chat mid-recovery across the deploy does not regress.
  it('#520 back-compat: a legacy boolean replayOverflow reads as k=1', () => {
    expect(
      lastAssistantReplayOverflowCount([
        row('assistant', { replayOverflow: true }),
        row('user', null),
      ]),
    ).toBe(1);
    // A legacy row with the flag absent/false is k=0.
    expect(
      lastAssistantReplayOverflowCount([row('assistant', { contextTokens: 5 })]),
    ).toBe(0);
  });

  // A corrupt/negative persisted count never yields a negative k.
  it('clamps a corrupt negative count to 0', () => {
    expect(
      lastAssistantReplayOverflowCount([
        row('assistant', { replayOverflowCount: -4 }),
      ]),
    ).toBe(0);
  });

  // #490/#520 reactive recovery: the prior consecutive-overflow count `k` drives
  // the next turn's effective budget to an ESCALATING cut (0.5**k) — each further
  // consecutive 400 tightens it, which is what un-bricks a chat that keeps
  // overflowing. This exercises the exact wiring the service uses: read the count,
  // then scale the threshold.
  it('#490/#520: the prior count drives the next turn to the escalating aggressive budget', () => {
    const history = [
      row('assistant', { replayOverflowCount: 1 }),
      row('user', null),
    ];
    const k = lastAssistantReplayOverflowCount(history);
    expect(k).toBe(1);
    // Base budget 100k -> first-overflow recovery halves it to 50k this turn.
    expect(resolveEffectiveReplayThreshold(100_000, k)).toBe(50_000);
    // A second consecutive overflow (k=2) quarters it.
    expect(resolveEffectiveReplayThreshold(100_000, 2)).toBe(25_000);
    // Odd base floors, not rounds.
    expect(resolveEffectiveReplayThreshold(99_999, 1)).toBe(49_999);
    // No prior overflow (k=0) -> the base budget is used verbatim (no cut).
    expect(resolveEffectiveReplayThreshold(100_000, 0)).toBe(100_000);
    // An explicit off-switch (null) is never overridden, even on recovery.
    expect(resolveEffectiveReplayThreshold(null, 3)).toBeNull();
  });

  // #520 escalation table + convergence: the cut deepens each consecutive overflow
  // and is CLAMPED at the floor so it converges (un-bricks even against a small
  // real window), instead of the old fixed single 0.5× that stuck at 50k forever.
  it('#520: escalates and converges to the floor, un-bricking a small real window', () => {
    const base = 100_000;
    expect(resolveEffectiveReplayThreshold(base, 0)).toBe(base);
    expect(resolveEffectiveReplayThreshold(base, 1)).toBe(50_000);
    expect(resolveEffectiveReplayThreshold(base, 2)).toBe(25_000);
    expect(resolveEffectiveReplayThreshold(base, 3)).toBe(12_500);

    // Residual-brick regression (#520): with the flat-default base (100k) and a real
    // model window of ~40k, the OLD fixed 0.5× stuck at 50k forever (> 40k -> 400s
    // again, never recovers). The escalating cut drops BELOW 40k after enough
    // consecutive overflows -> the history finally fits -> the chat un-bricks.
    const realWindow = 40_000;
    // k=1 (50k) still exceeds the window — the old behavior's terminal state.
    expect(resolveEffectiveReplayThreshold(base, 1)).toBeGreaterThan(realWindow);
    // But escalation converges under the window within a couple more turns.
    const converged = [2, 3, 4, 5].some(
      (k) => (resolveEffectiveReplayThreshold(base, k) as number) < realWindow,
    );
    expect(converged).toBe(true);

    // Convergence is bounded BELOW by the floor: a large k never trims below it.
    for (const k of [4, 8, 20, 100]) {
      expect(resolveEffectiveReplayThreshold(base, k)).toBe(REPLAY_MIN_FLOOR_TOKENS);
      expect(
        resolveEffectiveReplayThreshold(base, k) as number,
      ).toBeGreaterThanOrEqual(REPLAY_MIN_FLOOR_TOKENS);
    }
  });

  // The floor never RAISES a legitimately small configured budget above itself —
  // that would re-overflow the very window it was configured for. Under #520 Option B
  // recovery MAY cut it BELOW itself (down to floor(0.5×base) = the old 0.5× cut).
  it('#520: never inflates a small configured budget above itself (may cut below)', () => {
    const small = 5_000; // below the floor
    const floor = Math.min(REPLAY_MIN_FLOOR_TOKENS, Math.floor(small * 0.5)); // 2500
    expect(resolveEffectiveReplayThreshold(small, 0)).toBe(small);
    // Even under escalation the effective threshold never exceeds the base, and never
    // drops below the absolute floor.
    for (const k of [1, 2, 3, 10]) {
      const t = resolveEffectiveReplayThreshold(small, k) as number;
      expect(t).toBeLessThanOrEqual(small);
      expect(t).toBeGreaterThanOrEqual(floor);
    }
    // Option B: on overflow it DOES cut below the configured budget (old floor==budget
    // behavior would keep this at `small`).
    expect(resolveEffectiveReplayThreshold(small, 1)).toBe(floor);
  });
});

describe('rowToUiMessage', () => {
  it('prefers metadata.parts over content', () => {
    const row = {
      id: 'm1',
      role: 'assistant',
      content: 'plain text',
      metadata: { parts: [{ type: 'text', text: 'rich part' }] },
    } as unknown as AiChatMessage;
    const ui = rowToUiMessage(row);
    expect(ui.role).toBe('assistant');
    expect(ui.parts).toEqual([{ type: 'text', text: 'rich part' }]);
  });

  it('falls back to a single text part from content when no metadata.parts', () => {
    const row = {
      id: 'm2',
      role: 'user',
      content: 'hi there',
      metadata: null,
    } as unknown as AiChatMessage;
    const ui = rowToUiMessage(row);
    expect(ui.role).toBe('user');
    expect(ui.parts).toEqual([{ type: 'text', text: 'hi there' }]);
  });
});

/**
 * Unit tests for prepareAgentStep: the pure helper that decides per-step
 * overrides for the agent loop (#332 deferred tools, #444 final-step lockdown
 * toggle + step-budget warning). Parametrized by the two toggles so a change to
 * one path cannot silently mask a regression in the other.
 *
 * Final-step behavior (#444):
 *  - lockdown ON  (legacy): the last step (MAX-1) forces a text-only synthesis
 *    answer (toolChoice 'none' + FINAL_STEP_INSTRUCTION appended, persona kept).
 *  - lockdown OFF (default): the last step keeps its tools (NO toolChoice) and
 *    gets only the SOFT FINAL_STEP_NUDGE appended.
 */
// Narrowing helpers for the prepareAgentStep union return type.
const asLockdown = (r: ReturnType<typeof prepareAgentStep>) =>
  r as { toolChoice: 'none'; system: string };
const asActive = (r: ReturnType<typeof prepareAgentStep>) =>
  r as { activeTools: string[]; system?: string };
const asSystemOnly = (r: ReturnType<typeof prepareAgentStep>) =>
  r as { system: string };

describe('prepareAgentStep', () => {
  // --- deferred OFF, lockdown OFF (the new default) ---
  it('returns undefined for the first step (both toggles off)', () => {
    expect(prepareAgentStep(0, 'SYS')).toBeUndefined();
  });

  it('returns undefined for a clean non-final, non-warning step', () => {
    // A step below the warning band and not the last => no override at all.
    expect(prepareAgentStep(MAX_AGENT_STEPS - 10, 'SYS')).toBeUndefined();
  });

  it('final step (lockdown OFF) keeps tools and appends only the SOFT nudge', () => {
    const result = asSystemOnly(prepareAgentStep(MAX_AGENT_STEPS - 1, 'SYS'));
    expect(result).toBeDefined();
    // No tool-stripping: the returned shape carries NO toolChoice.
    expect(
      (result as unknown as { toolChoice?: string }).toolChoice,
    ).toBeUndefined();
    expect(result.system.startsWith('SYS')).toBe(true);
    expect(result.system).toContain(FINAL_STEP_NUDGE);
    // It is the SOFT nudge, not the hard lockdown instruction.
    expect(result.system).not.toContain(FINAL_STEP_INSTRUCTION);
  });

  // --- lockdown ON (legacy): unchanged tool-stripping on the last step ---
  it('final step (lockdown ON) forces a text-only synthesis', () => {
    const result = asLockdown(
      prepareAgentStep(MAX_AGENT_STEPS - 1, 'SYS', [], false, true),
    );
    expect(result.toolChoice).toBe('none');
    // The original persona is preserved (prefix), not replaced.
    expect(result.system.startsWith('SYS')).toBe(true);
    // The synthesis instruction is appended (NOT the soft nudge).
    expect(result.system).toContain(FINAL_STEP_INSTRUCTION);
    expect(result.system).not.toContain(FINAL_STEP_NUDGE);
  });

  it('does NOT narrow activeTools when deferred is off', () => {
    const result = prepareAgentStep(0, 'SYS', new Set(['createPage']), false);
    expect(result).toBeUndefined();
  });

  // --- deferred ON (#332): deferred tool visibility ---
  it('a non-final step exposes CORE + loadTools + activatedTools', () => {
    const activated = new Set<string>();
    const result = asActive(prepareAgentStep(0, 'SYS', activated, true));
    expect(result.activeTools).toContain('searchPages'); // core
    expect(result.activeTools).toContain('searchInPage'); // #330, core
    expect(result.activeTools).toContain('editPageText'); // core
    expect(result.activeTools).toContain('loadTools'); // meta-tool
    // No deferred tool is active before it is loaded.
    expect(result.activeTools).not.toContain('createPage');
    expect(result.activeTools).not.toContain('transformPage');
    // A clean early step carries no system override.
    expect(result.system).toBeUndefined();
  });

  it('adding a name to activatedTools makes it appear on the next step', () => {
    const activated = new Set<string>();
    // Before loading: createPage is not active.
    expect(
      asActive(prepareAgentStep(1, 'SYS', activated, true)).activeTools,
    ).not.toContain('createPage');
    // loadTools grows the SAME set…
    activated.add('createPage');
    // …so the next step sees it.
    const next = asActive(prepareAgentStep(2, 'SYS', activated, true));
    expect(next.activeTools).toContain('createPage');
    expect(next.activeTools).toContain('loadTools');
  });

  it('accepts an array for activatedTools too', () => {
    const result = asActive(prepareAgentStep(0, 'SYS', ['transformPage'], true));
    expect(result.activeTools).toContain('transformPage');
    expect(result.activeTools).toContain('loadTools');
  });

  // --- deferred ON + final step, per lockdown toggle (#444) ---
  it('deferred ON, lockdown OFF: last step KEEPS tools + soft nudge together', () => {
    const result = asActive(
      prepareAgentStep(
        MAX_AGENT_STEPS - 1,
        'SYS',
        new Set(['createPage']),
        true,
        false,
      ),
    );
    // Tools stay narrowed to CORE + loadTools + activated (NOT stripped).
    expect(result.activeTools).toContain('editPageText');
    expect(result.activeTools).toContain('loadTools');
    expect(result.activeTools).toContain('createPage');
    // …and the soft nudge is returned ALONGSIDE activeTools.
    expect(result.system).toContain(FINAL_STEP_NUDGE);
    expect(
      (result as unknown as { toolChoice?: string }).toolChoice,
    ).toBeUndefined();
  });

  it('deferred ON, lockdown ON: lockdown WINS (tools stripped)', () => {
    const result = asLockdown(
      prepareAgentStep(
        MAX_AGENT_STEPS - 1,
        'SYS',
        new Set(['createPage']),
        true,
        true,
      ),
    );
    // The lockdown shape (toolChoice none + synthesis) — not the activeTools shape.
    expect(result.toolChoice).toBe('none');
    expect(result.system).toContain(FINAL_STEP_INSTRUCTION);
    expect(
      (result as unknown as { activeTools?: string[] }).activeTools,
    ).toBeUndefined();
  });
});

/**
 * Step-budget warning boundaries (#444). At MAX_AGENT_STEPS=50 the warning fires
 * on steps MAX-6 .. MAX-2 (44..48) with a decreasing remaining-count, is CLEAN
 * below the band (0..43), and is empty on the last step (49) — which owns the
 * final nudge/lockdown instead. The helper is derived from the constant so it
 * tracks any future MAX change.
 */
describe('stepBudgetWarning boundaries', () => {
  const LAST = MAX_AGENT_STEPS - 1; // 49 at MAX=50
  const BAND_START = MAX_AGENT_STEPS - STEP_BUDGET_WARNING_LEAD; // 44

  it('is empty on every step below the warning band (0..BAND_START-1)', () => {
    for (let s = 0; s < BAND_START; s++) {
      expect(stepBudgetWarning(s)).toBe('');
    }
  });

  it('fires on BAND_START..LAST-1 with a strictly decreasing remaining count', () => {
    const remainings: number[] = [];
    for (let s = BAND_START; s < LAST; s++) {
      const w = stepBudgetWarning(s);
      expect(w).toContain('tool-use steps remain');
      const m = w.match(/Only (\d+) tool-use steps remain/);
      expect(m).not.toBeNull();
      remainings.push(Number(m![1]));
    }
    // Exactly STEP_BUDGET_WARNING_LEAD-1 warning steps (44..48).
    expect(remainings).toHaveLength(STEP_BUDGET_WARNING_LEAD - 1);
    // Remaining = MAX-1-step, so it decreases by 1 each step and ends at 1.
    for (let i = 1; i < remainings.length; i++) {
      expect(remainings[i]).toBe(remainings[i - 1] - 1);
    }
    expect(remainings[remainings.length - 1]).toBe(1);
  });

  it('is empty on the LAST step (its nudge/lockdown lives in prepareAgentStep)', () => {
    expect(stepBudgetWarning(LAST)).toBe('');
  });

  it('prepareAgentStep appends the warning on a band step (deferred/lockdown off)', () => {
    const result = asSystemOnly(prepareAgentStep(BAND_START, 'SYS'));
    expect(result.system).toContain('Stop exploring and start acting now');
    expect(result.system).not.toContain(FINAL_STEP_NUDGE);
  });
});

/**
 * flushAssistant (#183): the PURE row builder behind the step-granular durable
 * write path. It runs identically for the upfront insert (empty steps,
 * 'streaming'), every per-step update, and the terminal finalize — so a future
 * background worker can call the same function. These tests pin the four status
 * shapes and the `metadata.parts` shape that rowToUiMessage/findAllByChat depend on
 * (per-step text + tool parts via assistantParts, in-progress text appended).
 */
describe('flushAssistant', () => {
  type AnyPart = Record<string, unknown>;

  const toolStep = {
    text: 'looked it up',
    toolCalls: [{ toolCallId: 'c1', toolName: 'getPage', input: { id: 'p1' } }],
    toolResults: [
      { toolCallId: 'c1', toolName: 'getPage', output: { title: 'T' } },
    ],
  };

  it('upfront seed: empty streaming row (no content, no toolCalls, empty parts)', () => {
    const f = flushAssistant([], '', 'streaming');
    expect(f.status).toBe('streaming');
    expect(f.content).toBe('');
    expect(f.toolCalls).toBeNull();
    expect(f.metadata.parts).toEqual([]);
    // No finishReason while streaming (it is not a terminal state).
    expect('finishReason' in f.metadata).toBe(false);
  });

  it('streaming update folds in finished steps but keeps status streaming', () => {
    const f = flushAssistant([toolStep], '', 'streaming');
    expect(f.status).toBe('streaming');
    expect(f.content).toBe('looked it up');
    const parts = f.metadata.parts as AnyPart[];
    expect(parts).toContainEqual({ type: 'text', text: 'looked it up' });
    const toolPart = parts.find((p) => p.type === 'tool-getPage');
    expect(toolPart!.state).toBe('output-available');
    expect(f.toolCalls).not.toBeNull();
  });

  it('completed: attaches finishReason + normalized usage + contextTokens + maxContextTokens', () => {
    const f = flushAssistant([toolStep], '', 'completed', {
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      contextTokens: 15,
      maxContextTokens: 200000,
    });
    expect(f.status).toBe('completed');
    expect(f.metadata.finishReason).toBe('stop');
    expect(f.metadata.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      reasoningTokens: undefined,
    });
    expect(f.metadata.contextTokens).toBe(15);
    expect(f.metadata.maxContextTokens).toBe(200000);
  });

  it('completed: omits maxContextTokens when unset or 0', () => {
    // No maxContextTokens in the extra (admin set no context window).
    const f = flushAssistant([toolStep], '', 'completed', {
      finishReason: 'stop',
      contextTokens: 15,
    });
    expect('maxContextTokens' in f.metadata).toBe(false);
    // Explicit 0 is treated the same as unset (no limit -> key omitted).
    const f0 = flushAssistant([toolStep], '', 'completed', {
      finishReason: 'stop',
      contextTokens: 15,
      maxContextTokens: 0,
    });
    expect('maxContextTokens' in f0.metadata).toBe(false);
  });

  it('error: records the error and a derived finishReason', () => {
    const f = flushAssistant([], 'partial answer', 'error', { error: 'boom' });
    expect(f.status).toBe('error');
    expect(f.content).toBe('partial answer');
    expect(f.metadata.error).toBe('boom');
    // Derives finishReason from the terminal status when none is supplied.
    expect(f.metadata.finishReason).toBe('error');
    expect(f.metadata.parts).toEqual([
      { type: 'text', text: 'partial answer' },
    ]);
  });

  it('aborted: in-progress text appended last, no error key', () => {
    const f = flushAssistant([toolStep], ' and then', 'aborted');
    expect(f.status).toBe('aborted');
    expect(f.metadata.finishReason).toBe('aborted');
    expect('error' in f.metadata).toBe(false);
    expect(f.content).toBe('looked it up and then');
    const parts = f.metadata.parts as AnyPart[];
    expect(parts[parts.length - 1]).toEqual({
      type: 'text',
      text: ' and then',
    });
  });

  it('combines a finished tool step with trailing in-progress text (error path)', () => {
    // The error path captures the PARTIAL answer the user already saw: each
    // finished step's text + tool parts, then the in-progress step's text last.
    const flushed = flushAssistant([toolStep], ' and then', 'error', {
      error: 'boom',
    });
    const parts = flushed.metadata.parts as AnyPart[];
    expect(parts).toContainEqual({ type: 'text', text: 'looked it up' });
    const toolPart = parts.find((p) => p.type === 'tool-getPage');
    expect(toolPart!.state).toBe('output-available');
    // In-progress text appended LAST so the parts match the stream order.
    expect(parts[parts.length - 1]).toEqual({
      type: 'text',
      text: ' and then',
    });
    expect(flushed.content).toBe('looked it up and then');
    expect(flushed.toolCalls).not.toBeNull();
    expect(flushed.metadata.error).toBe('boom');
  });

  // #490/#520 observability: the replay budgeter's decision is stamped on the turn,
  // now including the consecutive-overflow COUNTER (#520) the next turn escalates on.
  it('records replayTrimmedToTokens + replayOverflowCount when provided', () => {
    const f = flushAssistant([], '', 'error', {
      error: 'ctx',
      replayTrimmedToTokens: 42_000,
      replayOverflowCount: 2,
    });
    expect(f.metadata.replayTrimmedToTokens).toBe(42_000);
    expect(f.metadata.replayOverflowCount).toBe(2);
  });

  it('omits the replay metadata when not provided', () => {
    const f = flushAssistant([], '', 'completed', { finishReason: 'stop' });
    expect('replayTrimmedToTokens' in f.metadata).toBe(false);
    expect('replayOverflowCount' in f.metadata).toBe(false);
    expect('replayBelowConfiguredBudget' in f.metadata).toBe(false);
  });

  // #520 Option B observability: the turn is marked when recovery replayed BELOW the
  // admin-configured budget, so the UI/telemetry can surface "config too large".
  it('stamps replayBelowConfiguredBudget when recovery cut below the configured budget', () => {
    const f = flushAssistant([], '', 'error', {
      error: 'ctx',
      replayOverflowCount: 2,
      replayBelowConfiguredBudget: true,
    });
    // MUTATION SENTINEL: dropping the metadata stamp in flushAssistant reddens this.
    expect(f.metadata.replayBelowConfiguredBudget).toBe(true);
  });

  it('omits replayBelowConfiguredBudget on a normal in-budget replay', () => {
    // false/omitted must NOT leave the flag on the turn (only the below-budget case).
    const off = flushAssistant([], '', 'completed', {
      replayBelowConfiguredBudget: false,
    });
    expect('replayBelowConfiguredBudget' in off.metadata).toBe(false);
  });

  // A clean finalize (no overflow -> count 0/omitted) leaves NO counter, which the
  // next turn reads as k=0 — the reset that ends a recovery streak.
  it('omits replayOverflowCount for a zero/absent count (reset semantics)', () => {
    const zero = flushAssistant([], '', 'completed', { replayOverflowCount: 0 });
    expect('replayOverflowCount' in zero.metadata).toBe(false);
  });

  // #274 observability: the page-change diff the agent saw this turn is persisted
  // to metadata.pageChanged when a non-empty diff was injected, and omitted when
  // the diff is empty/whitespace or the arg is not supplied.
  it('persists metadata.pageChanged when a non-empty diff was injected', () => {
    const f = flushAssistant([], '', 'completed', {
      pageChanged: { title: 'Doc', diff: '@@ -1 +1 @@\n-old\n+new' },
    });
    expect(f.metadata.pageChanged).toEqual({
      title: 'Doc',
      diff: '@@ -1 +1 @@\n-old\n+new',
    });
  });

  it('omits metadata.pageChanged for an empty/whitespace diff or a missing arg', () => {
    const whitespace = flushAssistant([], '', 'completed', {
      pageChanged: { title: 'Doc', diff: '   \n  ' },
    });
    expect('pageChanged' in whitespace.metadata).toBe(false);

    const nullArg = flushAssistant([], '', 'completed', { pageChanged: null });
    expect('pageChanged' in nullArg.metadata).toBe(false);

    const omitted = flushAssistant([], '', 'streaming');
    expect('pageChanged' in omitted.metadata).toBe(false);
  });
});

/**
 * stripNulChars: a NUL (U+0000) is rejected by Postgres in BOTH the `content`
 * (text) and `toolCalls`/`metadata` (jsonb) columns, so it must be stripped from
 * every persisted string. String.fromCharCode(0) avoids embedding a raw NUL byte
 * in this source file.
 */
describe('stripNulChars', () => {
  const NUL = String.fromCharCode(0);

  it('deep-strips NUL from strings in nested objects/arrays', () => {
    const out = stripNulChars({
      content: `a${NUL}b`,
      parts: [{ type: 'text', text: `x${NUL}${NUL}y` }],
      nested: [`p${NUL}q`, 42, null],
    });
    expect(out.content).toBe('ab');
    expect((out.parts[0] as { text: string }).text).toBe('xy');
    expect(out.nested[0]).toBe('pq');
    expect(out.nested[1]).toBe(42);
    expect(out.nested[2]).toBeNull();
    expect(JSON.stringify(out).includes(NUL)).toBe(false);
  });

  it('returns the SAME reference when there is no NUL (no needless clone)', () => {
    const input = { a: 'clean', b: [1, 2, { c: 'ok' }] };
    expect(stripNulChars(input)).toBe(input);
  });

  it('flushAssistant produces a NUL-free row even when the turn text carries one', () => {
    const f = flushAssistant([], `partial${NUL}answer`, 'error', {
      error: `bo${NUL}om`,
    });
    expect(f.content).toBe('partialanswer');
    const serialized =
      f.content + JSON.stringify(f.toolCalls) + JSON.stringify(f.metadata);
    expect(serialized.includes(NUL)).toBe(false);
  });
});

/**
 * chatStreamMetadata: attach metadata to the streamed assistant UI message per
 * part type — `chatId` on `start` (so the client adopts the real created chat id
 * at the first chunk — see #137), and AUTHORITATIVE usage (incl. reasoning
 * tokens) on `finish-step` and `finish` so the client's live token counter snaps
 * to exact at each step/turn boundary.
 */
describe('chatStreamMetadata', () => {
  it('returns { chatId } for the start part', () => {
    expect(chatStreamMetadata({ type: 'start' }, 'chat-1')).toEqual({
      chatId: 'chat-1',
    });
  });

  it('attaches the runId on the start part when a run wraps the turn (#184)', () => {
    expect(
      chatStreamMetadata({ type: 'start' }, 'chat-1', undefined, 'run-1'),
    ).toEqual({ chatId: 'chat-1', runId: 'run-1' });
  });

  it('returns the CUMULATIVE step usage passed in for the finish-step part', () => {
    // finish-step usage is per-step in v6; the caller accumulates and passes the
    // running sum, which this just wraps.
    expect(
      chatStreamMetadata(
        { type: 'finish-step', usage: { outputTokens: 100 } },
        'chat-1',
        {
          inputTokens: 500,
          outputTokens: 220,
          totalTokens: 720,
          reasoningTokens: 30,
        },
      ),
    ).toEqual({
      usage: {
        inputTokens: 500,
        outputTokens: 220,
        totalTokens: 720,
        reasoningTokens: 30,
      },
    });
  });

  it('returns turn usage for the finish part (reasoning from deprecated top-level field)', () => {
    expect(
      chatStreamMetadata(
        {
          type: 'finish',
          totalUsage: {
            inputTokens: 1000,
            outputTokens: 250,
            totalTokens: 1250,
            reasoningTokens: 50,
          },
        },
        'chat-1',
      ),
    ).toEqual({
      usage: {
        inputTokens: 1000,
        outputTokens: 250,
        totalTokens: 1250,
        reasoningTokens: 50,
      },
    });
  });

  it('prefers outputTokenDetails.reasoningTokens over the deprecated field (finish)', () => {
    expect(
      chatStreamMetadata(
        {
          type: 'finish',
          totalUsage: {
            outputTokens: 100,
            reasoningTokens: 5,
            outputTokenDetails: { reasoningTokens: 30 },
          },
        },
        'chat-1',
      ),
    ).toEqual({
      usage: {
        inputTokens: undefined,
        outputTokens: 100,
        totalTokens: undefined,
        reasoningTokens: 30,
      },
    });
  });

  it('returns undefined for a finish-step with no accumulated usage', () => {
    expect(
      chatStreamMetadata({ type: 'finish-step' }, 'chat-1'),
    ).toBeUndefined();
  });

  it('returns undefined for an unrelated part (e.g. text-delta)', () => {
    expect(
      chatStreamMetadata({ type: 'text-delta' }, 'chat-1'),
    ).toBeUndefined();
  });
});

/**
 * accumulateStepUsage: sums per-step usage into a running cumulative total so the
 * client never sees the live counter jump DOWN on a multi-step agent turn (#151).
 */
describe('accumulateStepUsage', () => {
  it('sums every field across two steps', () => {
    expect(
      accumulateStepUsage(
        {
          inputTokens: 500,
          outputTokens: 100,
          totalTokens: 600,
          reasoningTokens: 30,
        },
        {
          inputTokens: 520,
          outputTokens: 80,
          totalTokens: 600,
          reasoningTokens: 10,
        },
      ),
    ).toEqual({
      inputTokens: 1020,
      outputTokens: 180,
      totalTokens: 1200,
      reasoningTokens: 40,
    });
  });

  it('returns the step as-is when there is no accumulator yet', () => {
    expect(accumulateStepUsage(undefined, { outputTokens: 10 })).toEqual({
      outputTokens: 10,
    });
  });

  it('returns the accumulator unchanged when the step usage is absent', () => {
    const acc = { outputTokens: 10 };
    expect(accumulateStepUsage(acc, undefined)).toBe(acc);
  });

  it('returns undefined when both sides are absent', () => {
    expect(accumulateStepUsage(undefined, undefined)).toBeUndefined();
  });

  it('keeps a field undefined only when neither side has it', () => {
    expect(
      accumulateStepUsage({ outputTokens: 5 }, { outputTokens: 7 }),
    ).toEqual({
      inputTokens: undefined,
      outputTokens: 12,
      totalTokens: undefined,
      reasoningTokens: undefined,
    });
  });
});

/**
 * Contract test for the #180 wiring in AiChatService.handle: the external MCP
 * toolset must be built BEFORE the system prompt, and its per-server guidance
 * threaded into buildSystemPrompt({ mcpInstructions }). The full streaming
 * handle() is not unit-testable, so this reproduces the exact prompt-build call
 * the service makes with a connected-server toolset and asserts the guidance is
 * present. The toolsFor->buildSystemPrompt ordering is additionally enforced at
 * compile time (the prompt input now consumes external.instructions).
 */
describe('AiChatService system prompt wiring (#180)', () => {
  const workspace = { name: 'Acme' } as unknown as Workspace;

  it('includes the external MCP server instructions in the built system prompt', () => {
    // Shape returned by mcpClients.toolsFor (only `instructions` matters here).
    const external: Pick<
      Awaited<ReturnType<McpClientsService['toolsFor']>>,
      'instructions'
    > = {
      instructions: [
        {
          serverName: 'Tavily',
          toolPrefix: 'tavily',
          instructions: 'Prefer tavily_search for current events.',
        },
      ],
    };

    // Exactly the call the service makes after building the external toolset.
    const system = buildSystemPrompt({
      workspace,
      adminPrompt: 'persona',
      mcpInstructions: external.instructions,
    });

    expect(system).toContain('<mcp_tooling');
    expect(system).toContain('Tavily');
    expect(system).toContain('tavily_*');
    expect(system).toContain('Prefer tavily_search for current events.');
  });

  it('renders no MCP block when there are no external servers (empty instructions)', () => {
    const system = buildSystemPrompt({
      workspace,
      adminPrompt: 'persona',
      mcpInstructions: [],
    });
    expect(system).not.toContain('<mcp_tooling');
  });
});

/**
 * resolveOpenPageContext: the open page the client sends is attacker-controllable
 * (id AND title), so the service must validate the id against the DB and take the
 * title from the DB row — never echo the client title (#159, AI edits the wrong
 * page). Built with Object.create so the test exercises the real method without
 * the service's full dependency graph (the constructor only assigns fields).
 */
describe('AiChatService.resolveOpenPageContext (#159 current-page validation)', () => {
  const ws = { id: 'ws-1' } as Workspace;
  const user = { id: 'u-1' } as any;

  function makeService(opts: {
    page?: {
      id: string;
      workspaceId: string;
      title: string | null;
      updatedAt?: Date;
    } | null;
    canView?: boolean | 'throw-other';
  }) {
    const svc = Object.create(AiChatService.prototype) as AiChatService;
    (svc as any).logger = { warn: () => {} };
    (svc as any).pageRepo = {
      findById: async () => opts.page ?? undefined,
    };
    (svc as any).pageAccess = {
      validateCanView: async () => {
        if (opts.canView === 'throw-other') throw new Error('db down');
        if (opts.canView === false) throw new ForbiddenException();
        return true;
      },
    };
    return svc;
  }

  const call = (svc: AiChatService, openPage: any) =>
    (svc as any).resolveOpenPageContext(openPage, ws, user) as Promise<{
      id: string;
      title: string;
      updatedAt: Date;
      selection: unknown;
    } | null>;

  it('returns null when no page is open (no id)', async () => {
    const svc = makeService({});
    expect(await call(svc, null)).toBeNull();
    expect(await call(svc, {})).toBeNull();
    expect(await call(svc, { title: 'spoofed' })).toBeNull();
  });

  it('returns null when the page does not exist', async () => {
    const svc = makeService({ page: null });
    expect(await call(svc, { id: 'p-x' })).toBeNull();
  });

  it('returns null for a page in a DIFFERENT workspace (tenant isolation)', async () => {
    const svc = makeService({
      page: { id: 'p-1', workspaceId: 'ws-OTHER', title: 'Secret' },
    });
    expect(await call(svc, { id: 'p-1' })).toBeNull();
  });

  it('returns null when the user may not view the page (Forbidden)', async () => {
    const svc = makeService({
      page: { id: 'p-1', workspaceId: 'ws-1', title: 'Restricted' },
      canView: false,
    });
    expect(await call(svc, { id: 'p-1' })).toBeNull();
  });

  it('returns null (fail-closed) on a non-Forbidden access-check fault', async () => {
    const svc = makeService({
      page: { id: 'p-1', workspaceId: 'ws-1', title: 'X' },
      canView: 'throw-other',
    });
    expect(await call(svc, { id: 'p-1' })).toBeNull();
  });

  it('uses the AUTHORITATIVE DB title + updatedAt, IGNORING the client-supplied title', async () => {
    const updatedAt = new Date('2026-07-02T10:00:00Z');
    const svc = makeService({
      page: { id: 'p-1', workspaceId: 'ws-1', title: 'Real Title B', updatedAt },
      canView: true,
    });
    // The client claims it is on "Page A" but the id points at page B.
    const result = await call(svc, { id: 'p-1', title: 'Page A' });
    // updatedAt (#274 page-change fast path) is carried through from the DB row;
    // selection is null when the client sent none (#388).
    expect(result).toEqual({
      id: 'p-1',
      title: 'Real Title B',
      updatedAt,
      selection: null,
    });
  });

  it('coerces a null DB title to an empty string', async () => {
    const updatedAt = new Date('2026-07-02T10:00:00Z');
    const svc = makeService({
      page: { id: 'p-1', workspaceId: 'ws-1', title: null, updatedAt },
      canView: true,
    });
    expect(await call(svc, { id: 'p-1' })).toEqual({
      id: 'p-1',
      title: '',
      updatedAt,
      selection: null,
    });
  });

  // #388: the selection rides ONLY on a successful page resolve, and is
  // sanitized on the way through.
  it('attaches the SANITIZED selection on a successful resolve', async () => {
    const updatedAt = new Date('2026-07-02T10:00:00Z');
    const svc = makeService({
      page: { id: 'p-1', workspaceId: 'ws-1', title: 'Doc', updatedAt },
      canView: true,
    });
    const result = await call(svc, {
      id: 'p-1',
      selection: {
        text: 'fix this',
        blockIds: ['b1', 123, 'y'.repeat(65)], // garbage stripped by sanitize
        before: 'please ',
      },
    });
    expect(result).toEqual({
      id: 'p-1',
      title: 'Doc',
      updatedAt,
      selection: { text: 'fix this', blockIds: ['b1'], before: 'please ' },
    });
  });

  it('drops a blank/garbage selection to null on a successful resolve', async () => {
    const updatedAt = new Date('2026-07-02T10:00:00Z');
    const svc = makeService({
      page: { id: 'p-1', workspaceId: 'ws-1', title: 'Doc', updatedAt },
      canView: true,
    });
    expect(
      await call(svc, { id: 'p-1', selection: { text: '   ' } }),
    ).toEqual({ id: 'p-1', title: 'Doc', updatedAt, selection: null });
  });

  it('selection does NOT survive a foreign/inaccessible page (dies with the page)', async () => {
    // Forbidden page => the WHOLE context is null, so the selection is gone too.
    const svc = makeService({
      page: { id: 'p-1', workspaceId: 'ws-1', title: 'Restricted' },
      canView: false,
    });
    expect(
      await call(svc, { id: 'p-1', selection: { text: 'secret sel' } }),
    ).toBeNull();
  });
});

/**
 * sameInstant (#274 page-change fast path): equal instants => the open page is
 * untouched since the snapshot, so detection can skip the render + diff. A
 * missing/invalid timestamp must fall through (return false) so a bad value never
 * causes a false "nothing changed" skip that would lose a human edit.
 */
describe('sameInstant', () => {
  it('true for identical instants (Date and equivalent string)', () => {
    const d = new Date('2026-07-02T10:00:00Z');
    expect(sameInstant(d, new Date(d.getTime()))).toBe(true);
    expect(sameInstant(d, '2026-07-02T10:00:00.000Z')).toBe(true);
  });

  it('false for different instants', () => {
    expect(
      sameInstant(
        new Date('2026-07-02T10:00:00Z'),
        new Date('2026-07-02T10:00:01Z'),
      ),
    ).toBe(false);
  });

  it('false when either side is null/undefined/invalid', () => {
    const d = new Date('2026-07-02T10:00:00Z');
    expect(sameInstant(null, d)).toBe(false);
    expect(sameInstant(d, undefined)).toBe(false);
    expect(sameInstant(d, 'not-a-date')).toBe(false);
  });
});

/**
 * Page-change lifecycle (#274): detectPageChange (turn start) + snapshotOpenPage
 * (turn end) exercised with in-memory fakes (Object.create — no Nest graph, no
 * DB). Covers detection happy path / no-change / first-turn-seed-only / fast
 * path, the snapshot seed + deleted-page skip, and — the key regression — the
 * abort/error branch: after an aborted turn where the AGENT edited the page, the
 * snapshot must advance so the next turn does NOT mis-report the agent's own edit
 * as a user edit.
 */
describe('AiChatService page-change lifecycle (#274)', () => {
  const workspace = { id: 'ws-1' } as Workspace;
  const user = { id: 'u-1' } as any;
  const sessionId = 'sess-1';
  const T0 = new Date('2026-07-02T10:00:00Z');
  const T1 = new Date('2026-07-02T10:05:00Z');

  function makeService(opts: {
    snapshot?: { contentMd: string; pageUpdatedAt: Date };
    exportMd?: string;
    // pageRepo.findById result used by snapshotOpenPage. `null` models a deleted
    // page; omitted defaults to a same-workspace page at T1.
    page?: { workspaceId: string; updatedAt: Date } | null;
  }) {
    const store = new Map<string, any>();
    if (opts.snapshot) {
      store.set('c1|p1', {
        chatId: 'c1',
        pageId: 'p1',
        workspaceId: 'ws-1',
        ...opts.snapshot,
      });
    }
    // Mutable so a test can reconfigure between the abort-snapshot phase and the
    // next-turn detect phase.
    const state = {
      exportMd: opts.exportMd ?? '',
      page:
        opts.page === undefined
          ? { workspaceId: 'ws-1', updatedAt: T1 }
          : opts.page,
    };
    const exportCalls: string[] = [];

    const svc = Object.create(AiChatService.prototype) as AiChatService;
    (svc as any).logger = { warn: () => {}, error: () => {} };
    (svc as any).aiChatPageSnapshotRepo = {
      findByChatPage: async (chatId: string, pageId: string) =>
        store.get(`${chatId}|${pageId}`),
      upsert: async (v: any) => {
        store.set(`${v.chatId}|${v.pageId}`, { ...v });
        return v;
      },
    };
    (svc as any).tools = {
      exportPageMarkdown: async (
        _u: unknown,
        _s: unknown,
        _ws: unknown,
        _c: unknown,
        pageId: string,
      ) => {
        exportCalls.push(pageId);
        return state.exportMd;
      },
    };
    (svc as any).pageRepo = { findById: async () => state.page };
    return { svc, store, state, exportCalls };
  }

  const detect = (
    svc: AiChatService,
    openPage: { id: string; title: string; updatedAt: Date } | null,
  ) =>
    (svc as any).detectPageChange(
      'c1',
      openPage,
      workspace,
      user,
      sessionId,
    ) as Promise<{ title: string; diff: string } | null>;

  const snapshot = (svc: AiChatService) =>
    (svc as any).snapshotOpenPage(
      'c1',
      'p1',
      workspace,
      user,
      sessionId,
    ) as Promise<void>;

  it('detect: no note when the page is not open', async () => {
    const { svc } = makeService({});
    expect(await detect(svc, null)).toBeNull();
  });

  it('detect: first turn (no snapshot) seeds only, no note', async () => {
    const { svc, exportCalls } = makeService({});
    const res = await detect(svc, { id: 'p1', title: 'Doc', updatedAt: T0 });
    expect(res).toBeNull();
    // No snapshot => no render/diff at all.
    expect(exportCalls).toHaveLength(0);
  });

  it('detect: fast path skips render+diff when updatedAt is unchanged', async () => {
    const { svc, exportCalls } = makeService({
      snapshot: { contentMd: 'S0', pageUpdatedAt: T0 },
    });
    const res = await detect(svc, { id: 'p1', title: 'Doc', updatedAt: T0 });
    expect(res).toBeNull();
    expect(exportCalls).toHaveLength(0);
  });

  it('detect: user edit between turns yields a titled note + diff', async () => {
    const { svc } = makeService({
      snapshot: { contentMd: '# Title\n\nold body', pageUpdatedAt: T0 },
      exportMd: '# Title\n\nnew body',
    });
    const res = await detect(svc, { id: 'p1', title: 'Doc', updatedAt: T1 });
    expect(res).not.toBeNull();
    expect(res!.title).toBe('Doc');
    expect(res!.diff).toContain('-old body');
    expect(res!.diff).toContain('+new body');
  });

  it('detect: no note when content is unchanged despite a bumped updatedAt', async () => {
    const { svc } = makeService({
      snapshot: { contentMd: 'same content', pageUpdatedAt: T0 },
      exportMd: 'same content',
    });
    expect(
      await detect(svc, { id: 'p1', title: 'Doc', updatedAt: T1 }),
    ).toBeNull();
  });

  it('snapshot: seeds the current Markdown + page updatedAt', async () => {
    const { svc, store } = makeService({
      exportMd: 'Sa',
      page: { workspaceId: 'ws-1', updatedAt: T1 },
    });
    await snapshot(svc);
    const row = store.get('c1|p1');
    expect(row.contentMd).toBe('Sa');
    expect(row.pageUpdatedAt).toBe(T1);
  });

  it('snapshot: skips the write when the page was deleted during the turn', async () => {
    const { svc, store } = makeService({ exportMd: 'X', page: null });
    await snapshot(svc);
    expect(store.get('c1|p1')).toBeUndefined();
  });

  it('detect: swallows a best-effort fault (export throws) and returns null', async () => {
    // Snapshot present + a bumped updatedAt, so detection gets past the fast path
    // and calls exportPageMarkdown — which throws. The catch must downgrade to
    // "no note" (null) so the turn is never broken (#274 F4).
    const { svc } = makeService({
      snapshot: { contentMd: 'S0', pageUpdatedAt: T0 },
    });
    (svc as any).tools.exportPageMarkdown = async () => {
      throw new Error('export failed');
    };
    expect(
      await detect(svc, { id: 'p1', title: 'Doc', updatedAt: T1 }),
    ).toBeNull();
  });

  it('detect: swallows a repo fault (findByChatPage throws) and returns null', async () => {
    const { svc } = makeService({
      snapshot: { contentMd: 'S0', pageUpdatedAt: T0 },
    });
    (svc as any).aiChatPageSnapshotRepo.findByChatPage = async () => {
      throw new Error('db down');
    };
    expect(
      await detect(svc, { id: 'p1', title: 'Doc', updatedAt: T1 }),
    ).toBeNull();
  });

  it('snapshot: swallows a best-effort fault (upsert throws) and does not throw', async () => {
    const { svc } = makeService({
      exportMd: 'Sa',
      page: { workspaceId: 'ws-1', updatedAt: T1 },
    });
    (svc as any).aiChatPageSnapshotRepo.upsert = async () => {
      throw new Error('write failed');
    };
    await expect(snapshot(svc)).resolves.toBeUndefined();
  });

  it('abort branch: advancing the snapshot after an agent edit prevents a false note next turn', async () => {
    // Previous turn ended with the page at S0 @ T0.
    const { svc, store, state } = makeService({
      snapshot: { contentMd: 'S0 body', pageUpdatedAt: T0 },
    });

    // This turn the AGENT edited the page (committed to the DB) to "Sa body",
    // bumping updatedAt to T1, and then the turn ABORTED. The abort path runs the
    // same snapshot, which must advance the snapshot to what the agent left.
    state.exportMd = 'Sa body';
    state.page = { workspaceId: 'ws-1', updatedAt: T1 };
    await snapshot(svc);
    expect(store.get('c1|p1').contentMd).toBe('Sa body');
    expect(store.get('c1|p1').pageUpdatedAt).toBe(T1);

    // Next turn: nobody edited further; the page is still Sa @ T1. The agent's OWN
    // edit must NOT surface as a "user edited the page" note.
    const res = await detect(svc, { id: 'p1', title: 'Doc', updatedAt: T1 });
    expect(res).toBeNull();
  });

  it('abort branch: WITHOUT advancing the snapshot, the agent edit would wrongly surface (proves the fix)', async () => {
    // Same setup but the snapshot is NOT advanced (the pre-fix behaviour where
    // only onFinish snapshotted). The agent's committed edit then looks like a
    // between-turns user edit — exactly the bug FIX 1 removes.
    const { svc } = makeService({
      snapshot: { contentMd: 'S0 body', pageUpdatedAt: T0 },
      exportMd: 'Sa body',
    });
    const res = await detect(svc, { id: 'p1', title: 'Doc', updatedAt: T1 });
    expect(res).not.toBeNull();
    expect(res!.diff).toContain('+Sa body');
  });
});

/**
 * isInterruptResume (#198): the pure guard that decides whether the interrupt
 * note is injected for a turn. The client "send now" flag is only a hint; it is
 * honoured ONLY when the preceding assistant turn (history[len-2], since the new
 * user row is the tail) really ended unfinished ('aborted', or still 'streaming'
 * during the abort/resend race). A spoofed flag on an ordinary turn is ignored.
 */
describe('isInterruptResume', () => {
  // history tail is the just-inserted user row; [len-2] is the previous turn.
  const withPrev = (
    prev: {
      role: string;
      status?: string | null;
      metadata?: unknown;
    } | null,
  ): Array<{ role: string; status?: string | null; metadata?: unknown }> =>
    prev
      ? [prev, { role: 'user', status: null }]
      : [{ role: 'user', status: null }];

  it('false when the client flag is not set', () => {
    expect(
      isInterruptResume(withPrev({ role: 'assistant', status: 'aborted' }), undefined),
    ).toBe(false);
    expect(
      isInterruptResume(withPrev({ role: 'assistant', status: 'aborted' }), false),
    ).toBe(false);
  });

  it('true when flagged AND the previous assistant turn is aborted', () => {
    expect(
      isInterruptResume(withPrev({ role: 'assistant', status: 'aborted' }), true),
    ).toBe(true);
  });

  it('true when flagged AND the previous assistant turn is still streaming (race)', () => {
    expect(
      isInterruptResume(withPrev({ role: 'assistant', status: 'streaming' }), true),
    ).toBe(true);
  });

  it('false when flagged but the previous assistant turn completed normally', () => {
    expect(
      isInterruptResume(withPrev({ role: 'assistant', status: 'completed' }), true),
    ).toBe(false);
  });

  it('false when flagged but the previous turn is not an assistant turn', () => {
    expect(
      isInterruptResume(withPrev({ role: 'user', status: 'aborted' }), true),
    ).toBe(false);
  });

  it('false when there is no preceding turn (only the new user row)', () => {
    expect(isInterruptResume(withPrev(null), true)).toBe(false);
  });

  it('#487 EXCLUDES a reconcile stamp (finalizeFailed) — not a genuine interruption', () => {
    // A row a reconcile settled to 'aborted' carries metadata.finalizeFailed. It
    // must NOT be treated as an interrupt-resume (that would inject a false
    // "you were interrupted" note), even though its status is 'aborted'.
    expect(
      isInterruptResume(
        withPrev({
          role: 'assistant',
          status: 'aborted',
          metadata: { finalizeFailed: true },
        }),
        true,
      ),
    ).toBe(false);
    // A genuine abort (no finalizeFailed) still counts.
    expect(
      isInterruptResume(
        withPrev({
          role: 'assistant',
          status: 'aborted',
          metadata: { parts: [] },
        }),
        true,
      ),
    ).toBe(true);
  });
});

/**
 * #184 phase 1.5 — the run-wrapped pipe options (unit). Drives stream() to the
 * pipe call with streamText mocked, capturing the options object, and asserts:
 *  - flag OFF while a runId IS present -> the LEGACY option shape (no
 *    consumeSseStream, no generateMessageId), and the registry is never touched.
 *    This is the exact dormancy guarantee this PR rests on.
 *  - flag ON + runId -> consumeSseStream tees into the registry and
 *    generateMessageId returns the seeded assistant DB row id.
 *  - flag ON but no runHooks (runId undefined) -> legacy (the runId gate).
 *  - flag ON + runId -> the outer catch releases the entry via abortEntry.
 */
describe('AiChatService.stream — resumable pipe options (#184 phase 1.5)', () => {
  const streamTextMock = streamText as unknown as jest.Mock;
  let pipeMock: jest.Mock;

  beforeEach(() => {
    streamTextMock.mockReset();
    pipeMock = jest.fn();
    streamTextMock.mockReturnValue({
      consumeStream: jest.fn(),
      pipeUIMessageStreamToResponse: pipeMock,
    });
    // Silence the service's diagnostic logging for a clean test run.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined as never);
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined as never);
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => jest.restoreAllMocks());

  // A raw-response stub sufficient for the post-streamText wiring.
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

  // Wire only the deps reached on the way to the pipe call, plus a spy registry.
  function makeService(opts: { resumable: boolean; history?: unknown[] }) {
    const aiChatRepo = {
      findById: jest.fn(async () => ({ id: 'chat-1', workspaceId: 'ws-1' })),
      insert: jest.fn(),
    };
    const aiChatMessageRepo = {
      // Both the user insert and the assistant seed return the same row id.
      insert: jest.fn(async () => ({ id: 'msg-1' })),
      findAllByChat: jest.fn(async () => opts.history ?? []),
      update: jest.fn(async () => ({ id: 'msg-1' })),
      // #487: the terminal owner-write + the opportunistic reconcile query.
      finalizeOwner: jest.fn(async () => ({ id: 'msg-1' })),
      findStreamingWithTerminalRun: jest.fn(async () => []),
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
    const streamRegistry = {
      open: jest.fn(),
      bind: jest.fn(),
      abortEntry: jest.fn(),
    };
    const svc = new AiChatService(
      {} as never, // ai (model is injected)
      aiChatRepo as never,
      aiChatMessageRepo as never,
      {} as never, // aiChatPageSnapshotRepo
      aiSettings as never,
      tools as never,
      mcpClients as never,
      {} as never, // aiAgentRoleRepo
      {} as never, // pageRepo (openPage undefined -> never touched)
      {} as never, // pageAccess
      {
        isAiChatDeferredToolsEnabled: () => false,
        isAiChatFinalStepLockdownEnabled: () => false,
        isAiChatViewImageEnabled: () => false,
        isAiChatResumableStreamEnabled: () => opts.resumable,
      } as never,
      streamRegistry as never,
    );
    return { svc, streamRegistry, aiChatMessageRepo };
  }

  const body = {
    chatId: 'chat-1',
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ],
  };

  const makeRunHooks = () => ({
    begin: jest.fn(async () => ({
      runId: 'run-1',
      signal: new AbortController().signal,
    })),
    onAssistantSeeded: jest.fn(),
    onStep: jest.fn(),
    onSettled: jest.fn(),
  });

  async function drive(svc: AiChatService, hooks: unknown): Promise<void> {
    await svc.stream({
      user: { id: 'u1' } as never,
      workspace: { id: 'ws-1' } as never,
      sessionId: 's1',
      body: body as never,
      res: makeRes() as never,
      signal: new AbortController().signal,
      model: {} as never,
      role: null,
      runHooks: hooks as never,
    });
  }

  it('flag OFF + runId present: LEGACY option shape (no consumeSseStream / generateMessageId); registry untouched', async () => {
    const { svc, streamRegistry } = makeService({ resumable: false });
    await drive(svc, makeRunHooks());
    expect(pipeMock).toHaveBeenCalledTimes(1);
    const options = pipeMock.mock.calls[0][1];
    // The dormancy guarantee: a live run with the flag off tees NOTHING and does
    // not stamp a message id — byte-for-byte the pre-1.5 wire.
    expect(options.consumeSseStream).toBeUndefined();
    expect(options.generateMessageId).toBeUndefined();
    expect(streamRegistry.bind).not.toHaveBeenCalled();
    expect(streamRegistry.abortEntry).not.toHaveBeenCalled();
  });

  it('flag ON + runId: consumeSseStream tees into the registry; generateMessageId returns the seeded row id', async () => {
    const { svc, streamRegistry } = makeService({ resumable: true });
    await drive(svc, makeRunHooks());
    const options = pipeMock.mock.calls[0][1];
    expect(typeof options.consumeSseStream).toBe('function');
    expect(typeof options.generateMessageId).toBe('function');
    // generateMessageId stamps the seeded assistant DB row id.
    expect(options.generateMessageId()).toBe('msg-1');
    // consumeSseStream binds the tee: (chatId, runId, assistantId, stream).
    const fakeStream = {} as ReadableStream<string>;
    options.consumeSseStream({ stream: fakeStream });
    expect(streamRegistry.bind).toHaveBeenCalledWith(
      'chat-1',
      'run-1',
      'msg-1',
      fakeStream,
    );
  });

  it('flag ON but NO runHooks (runId undefined): pipe options stay legacy (the runId gate)', async () => {
    const { svc, streamRegistry } = makeService({ resumable: true });
    await drive(svc, undefined);
    const options = pipeMock.mock.calls[0][1];
    expect(options.consumeSseStream).toBeUndefined();
    expect(options.generateMessageId).toBeUndefined();
    expect(streamRegistry.bind).not.toHaveBeenCalled();
  });

  it('flag ON + runId: the outer catch calls abortEntry when the stream throws', async () => {
    const { svc, streamRegistry } = makeService({ resumable: true });
    streamTextMock.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(drive(svc, makeRunHooks())).rejects.toThrow('boom');
    expect(streamRegistry.abortEntry).toHaveBeenCalledWith('chat-1', 'run-1');
  });

  // #489 REGRESSION (against the REAL convertToModelMessages — not mocked here):
  // a persisted history row whose parts contain a `null` element makes the real
  // convertToModelMessages THROW ("Cannot read properties of null"). Pre-fix that
  // 500-ed every turn forever and each retry appended a duplicate user row. The
  // fix converts BEFORE the insert and isolates the poisoned row per-row, degrading
  // it to text with a "[tool context omitted]" marker. Assert the turn still runs,
  // the marker reaches the model, and exactly ONE user row is inserted.
  it('#489: a poisoned OLD-history row keeps the chat working; the marker reaches the model; one user insert', async () => {
    const { svc, aiChatMessageRepo } = makeService({
      resumable: false,
      history: [
        {
          id: 'old-1',
          role: 'assistant',
          content: 'earlier answer',
          // A null part is the poison: rowToUiMessage keeps it (the array is
          // non-empty) and the real convertToModelMessages throws on it.
          metadata: { parts: [{ type: 'text', text: 'earlier answer' }, null] },
          status: 'completed',
        },
      ],
    });
    // Must NOT throw — the poisoned row is degraded, not fatal.
    await drive(svc, makeRunHooks());
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const passedMessages = streamTextMock.mock.calls[0][0].messages;
    const serialized = JSON.stringify(passedMessages);
    // The model sees the truncation marker (silent tool-context loss is not ok)
    // AND the row's readable text is preserved alongside it.
    expect(serialized).toContain('[tool context omitted]');
    expect(serialized).toContain('earlier answer');
    // Exactly ONE user row inserted (no duplicate), inserted AFTER conversion.
    const userInserts = aiChatMessageRepo.insert.mock.calls
      .map((c: unknown[]) => c[0] as { role?: string })
      .filter((r) => r.role === 'user');
    expect(userInserts).toHaveLength(1);
  });

  // #489: client-supplied non-text parts (a tool-part in `input-available`, the
  // exact "bricking" payload) are dropped ON RECEIPT — never persisted — so they
  // can never poison future turns. Only the text survives into metadata.parts.
  it('#489: a non-text client part is stripped before persist (only text survives)', async () => {
    const { svc, aiChatMessageRepo } = makeService({ resumable: false });
    await svc.stream({
      user: { id: 'u1' } as never,
      workspace: { id: 'ws-1' } as never,
      sessionId: 's1',
      body: {
        chatId: 'chat-1',
        messages: [
          {
            id: 'm1',
            role: 'user',
            parts: [
              { type: 'text', text: 'hello' },
              // untrusted tool-part — must be dropped, never persisted
              {
                type: 'tool-getPage',
                toolCallId: 't1',
                state: 'input-available',
                input: { pageId: 'p' },
              },
            ],
          },
        ],
      } as never,
      res: makeRes() as never,
      signal: new AbortController().signal,
      model: {} as never,
      role: null,
      runHooks: makeRunHooks() as never,
    });
    const userInsert = aiChatMessageRepo.insert.mock.calls
      .map((c: unknown[]) => c[0] as { role?: string; metadata?: unknown })
      .find((r) => r.role === 'user');
    const parts = (userInsert?.metadata as { parts?: Array<{ type: string }> })
      ?.parts;
    expect(parts).toEqual([{ type: 'text', text: 'hello' }]);
  });
});

/**
 * #444 — the token-degeneration SAFETY REACTION path (integration).
 *
 * output-degeneration.spec.ts proves the detector DETECTS; this proves the wired
 * REACTION: a degenerate stream must (1) trip the detector in onChunk, (2) abort
 * the turn via the INTERNAL degeneration controller (distinct from a user Stop),
 * (3) truncate the runaway tail before persist in onAbort, (4) persist status
 * 'error' with the OUTPUT_DEGENERATION_ERROR message (not a bare 'aborted' and not
 * a swept 'streaming'), and (5) still release the leased external MCP clients.
 *
 * Harness: streamText is the SAME jest.fn mocked at the top of this file. Unlike
 * the pipe-options suite above (which only inspects the pipe call), this mock
 * CAPTURES the streamText options (onChunk/onAbort/onFinish + abortSignal) so the
 * test can drive the callbacks exactly as the AI SDK would — feeding degenerate
 * text-delta chunks through onChunk until the service's own AbortController fires,
 * then invoking onAbort (which the SDK does on an aborted signal). No new mocking
 * style is invented; it reuses the makeRes / service-construction shape above.
 */
describe('AiChatService.stream — token-degeneration reaction (#444)', () => {
  const streamTextMock = streamText as unknown as jest.Mock;

  beforeEach(() => {
    streamTextMock.mockReset();
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined as never);
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined as never);
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => jest.restoreAllMocks());

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

  // Wire the full stream() path with in-memory fakes. The assistant row is
  // captured so the terminal finalize (an UPDATE of the upfront-seeded row) can be
  // asserted. One external MCP client with a close() spy lets us assert leases are
  // released on the terminal path. lockdown OFF (default) so the detector is the
  // active guard.
  function makeService() {
    // The upfront insert seeds the assistant row; findById/insert stamp a stable
    // id so planFinalizeAssistant picks the UPDATE path.
    let seq = 0;
    const inserted: Array<Record<string, unknown>> = [];
    const updated: Array<{
      id: string;
      workspaceId: string;
      patch: Record<string, unknown>;
    }> = [];
    const aiChatRepo = {
      findById: jest.fn(async () => ({ id: 'chat-1', workspaceId: 'ws-1' })),
      insert: jest.fn(),
    };
    const aiChatMessageRepo = {
      insert: jest.fn(async (row: Record<string, unknown>) => {
        inserted.push(row);
        return { id: row.role === 'assistant' ? 'assistant-1' : `user-${++seq}` };
      }),
      findAllByChat: jest.fn(async () => []),
      update: jest.fn(
        async (
          id: string,
          workspaceId: string,
          patch: Record<string, unknown>,
        ) => {
          updated.push({ id, workspaceId, patch });
          return { id };
        },
      ),
      // #487: the terminal owner-write records into the SAME `updated` recorder so
      // assertions on the terminal 'completed'/'error'/'aborted' write still hold.
      finalizeOwner: jest.fn(
        async (
          id: string,
          workspaceId: string,
          patch: Record<string, unknown>,
        ) => {
          updated.push({ id, workspaceId, patch });
          return { id };
        },
      ),
      findStreamingWithTerminalRun: jest.fn(async () => []),
    };
    const aiSettings = { resolve: jest.fn(async () => ({})) };
    const tools = { forUser: jest.fn(async () => ({})) };
    const mcpClose = jest.fn(async () => undefined);
    const mcpClients = {
      toolsFor: jest.fn(async () => ({
        tools: {},
        clients: [{ close: mcpClose }],
        outcomes: [],
        instructions: [],
      })),
    };
    const streamRegistry = { open: jest.fn(), bind: jest.fn(), abortEntry: jest.fn() };
    const svc = new AiChatService(
      {} as never,
      aiChatRepo as never,
      aiChatMessageRepo as never,
      {} as never, // aiChatPageSnapshotRepo (no open page -> never touched)
      aiSettings as never,
      tools as never,
      mcpClients as never,
      {} as never, // aiAgentRoleRepo
      {} as never, // pageRepo (no open page)
      {} as never, // pageAccess
      {
        isAiChatDeferredToolsEnabled: () => false,
        // lockdown OFF => the degeneration detector is the anti-babble guard.
        isAiChatFinalStepLockdownEnabled: () => false,
        isAiChatViewImageEnabled: () => false,
        isAiChatResumableStreamEnabled: () => false,
      } as never,
      streamRegistry as never,
    );
    return { svc, inserted, updated, mcpClose };
  }

  const body = {
    chatId: 'chat-1',
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ],
  };

  // Capture the streamText options so the test can drive the SDK callbacks. The
  // returned result stub is enough for the post-streamText wiring (consumeStream +
  // pipeUIMessageStreamToResponse are no-ops here).
  function captureStreamText(): { opts: () => Record<string, any> } {
    let captured: Record<string, any> | undefined;
    streamTextMock.mockImplementation((options: Record<string, any>) => {
      captured = options;
      return {
        consumeStream: jest.fn(),
        pipeUIMessageStreamToResponse: jest.fn(),
      };
    });
    return {
      opts: () => {
        if (!captured) throw new Error('streamText was not called');
        return captured;
      },
    };
  }

  async function drive(svc: AiChatService): Promise<void> {
    await svc.stream({
      user: { id: 'u1' } as never,
      workspace: { id: 'ws-1' } as never,
      sessionId: 's1',
      body: body as never,
      res: makeRes() as never,
      signal: new AbortController().signal,
      model: {} as never,
      role: null,
      runHooks: undefined as never,
    });
  }

  it('degenerate stream: detects → internal abort → onAbort truncates + records OUTPUT_DEGENERATION_ERROR; leases released', async () => {
    const { svc, updated, mcpClose } = makeService();
    const cap = captureStreamText();
    await drive(svc);

    const opts = cap.opts();
    // The turn's abort signal is the UNION of the socket/run signal and the
    // internal degeneration controller — untripped before any output.
    expect(opts.abortSignal.aborted).toBe(false);

    // Feed a runaway "loadTools.\n" loop the way the SDK streams it: many small
    // text-delta chunks. The onChunk throttle only re-checks every ~2000 chars, so
    // deliver well past that so the detector's identical-line rule (>=25 lines)
    // and the ~2000-char throttle both fire.
    const line = 'loadTools.\n';
    let delivered = 0;
    for (let i = 0; i < 400 && !opts.abortSignal.aborted; i++) {
      opts.onChunk({ chunk: { type: 'text-delta', text: line } });
      delivered += line.length;
    }

    // The detector must have tripped and aborted via the INTERNAL controller — the
    // reason carries the degeneration message, distinguishing it from a user Stop
    // (which aborts with no such reason) or a socket disconnect.
    expect(opts.abortSignal.aborted).toBe(true);
    expect(delivered).toBeGreaterThan(2000);
    expect(String(opts.abortSignal.reason)).toContain(
      'Output degeneration detected',
    );

    // The SDK reacts to the aborted signal by invoking onAbort. `steps` is empty
    // (the runaway never finished a step); the in-progress runaway text is what
    // gets truncated + persisted.
    await opts.onAbort({ steps: [] });

    // Terminal finalize = an UPDATE of the upfront-seeded assistant row (assistant
    // row was inserted upfront, so planFinalizeAssistant -> UPDATE).
    expect(updated).toHaveLength(1);
    const patch = updated[0].patch as {
      status: string;
      content: string;
      metadata: Record<string, unknown>;
    };
    // (4) status 'error' with the degeneration message — NOT 'aborted' and NOT a
    // swept 'streaming'. This distinguishes it from a user Stop / server restart.
    expect(patch.status).toBe('error');
    expect(patch.metadata.error).toBe(OUTPUT_DEGENERATION_ERROR);
    expect(patch.metadata.finishReason).toBe('error');
    // (3) the runaway tail is TRUNCATED, not the full multi-KB babble: the marker
    // is present and the persisted content is far shorter than what was streamed.
    expect(patch.content).toContain('output truncated');
    expect(patch.content.length).toBeLessThan(delivered);
    // Only a few loop reps survive (truncateDegeneratedTail keeps a handful).
    expect((patch.content.match(/loadTools\./g) ?? []).length).toBeLessThan(10);

    // (5) the leased external MCP client is still released on this terminal path.
    expect(mcpClose).toHaveBeenCalledTimes(1);
  });

  it('degeneration onAbort differs from a NORMAL/user abort (no truncation, no error)', async () => {
    // Same harness, but the stream is NOT degenerate: a clean short answer, then a
    // user Stop reaches onAbort WITHOUT the degeneration controller having fired.
    const { svc, updated, mcpClose } = makeService();
    const cap = captureStreamText();
    await drive(svc);
    const opts = cap.opts();

    opts.onChunk({ chunk: { type: 'text-delta', text: 'A normal partial answer.' } });
    // The detector never tripped -> the union signal is NOT aborted by us.
    expect(opts.abortSignal.aborted).toBe(false);

    // A user Stop / disconnect drives onAbort with the partial (clean) text.
    await opts.onAbort({ steps: [] });

    expect(updated).toHaveLength(1);
    const patch = updated[0].patch as {
      status: string;
      content: string;
      metadata: Record<string, unknown>;
    };
    // A normal abort persists status 'aborted' with NO error and NO truncation
    // marker — the branch is genuinely distinguished from the degeneration path.
    expect(patch.status).toBe('aborted');
    expect('error' in patch.metadata).toBe(false);
    expect(patch.content).toBe('A normal partial answer.');
    expect(patch.content).not.toContain('output truncated');
    // Cleanup still runs on the normal abort path too.
    expect(mcpClose).toHaveBeenCalledTimes(1);
  });

  /**
   * Empty-turn marker (#444): onFinish appends STEP_LIMIT_NO_ANSWER_MARKER only
   * when the turn burned ALL its steps (steps.length >= MAX_AGENT_STEPS) AND never
   * produced any text. The negative: a normal turn ending WITH text is left alone.
   */
  it('empty turn (no text + steps exhausted) persists the STEP_LIMIT_NO_ANSWER_MARKER', async () => {
    const { svc, updated } = makeService();
    const cap = captureStreamText();
    await drive(svc);
    const opts = cap.opts();

    // MAX_AGENT_STEPS text-less steps (only tool calls) => step-exhausted, no text.
    const steps = Array.from({ length: MAX_AGENT_STEPS }, () => ({
      text: '',
      toolCalls: [{ toolCallId: 'c1', toolName: 'searchPages', input: {} }],
      toolResults: [
        { toolCallId: 'c1', toolName: 'searchPages', output: { hits: [] } },
      ],
    }));
    await opts.onFinish({
      text: '',
      finishReason: 'tool-calls',
      totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      usage: { inputTokens: 1, outputTokens: 1 },
      steps,
    });

    expect(updated).toHaveLength(1);
    const patch = updated[0].patch as { status: string; content: string };
    expect(patch.status).toBe('completed');
    // The synthetic marker is the trailing text of the persisted content.
    expect(patch.content).toContain(STEP_LIMIT_NO_ANSWER_MARKER);
  });

  it('normal turn ending WITH text does NOT get the empty-turn marker', async () => {
    const { svc, updated } = makeService();
    const cap = captureStreamText();
    await drive(svc);
    const opts = cap.opts();

    // A single step that produced a real answer, well under the step cap.
    const steps = [
      { text: 'Here is the finished answer.', toolCalls: [], toolResults: [] },
    ];
    await opts.onFinish({
      text: 'Here is the finished answer.',
      finishReason: 'stop',
      totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      usage: { inputTokens: 1, outputTokens: 1 },
      steps,
    });

    expect(updated).toHaveLength(1);
    const patch = updated[0].patch as { status: string; content: string };
    expect(patch.status).toBe('completed');
    expect(patch.content).toBe('Here is the finished answer.');
    expect(patch.content).not.toContain(STEP_LIMIT_NO_ANSWER_MARKER);
  });

  it('step-exhausted turn that DID produce text keeps the text, no marker (guards the AND)', async () => {
    // Exhausting the step budget alone must NOT append the marker when SOME step
    // produced text — the marker keys off "no text" too. Drive the real onFinish
    // with MAX_AGENT_STEPS steps where the last one carries the answer.
    const { svc, updated } = makeService();
    const cap = captureStreamText();
    await drive(svc);
    const opts = cap.opts();

    const steps = Array.from({ length: MAX_AGENT_STEPS }, (_, i) => ({
      text: i === MAX_AGENT_STEPS - 1 ? 'Final synthesized answer.' : '',
      toolCalls:
        i === MAX_AGENT_STEPS - 1
          ? []
          : [{ toolCallId: `c${i}`, toolName: 'searchPages', input: {} }],
      toolResults:
        i === MAX_AGENT_STEPS - 1
          ? []
          : [{ toolCallId: `c${i}`, toolName: 'searchPages', output: {} }],
    }));
    await opts.onFinish({
      text: 'Final synthesized answer.',
      finishReason: 'stop',
      totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      usage: { inputTokens: 1, outputTokens: 1 },
      steps,
    });

    expect(updated).toHaveLength(1);
    const patch = updated[0].patch as { content: string };
    expect(patch.content).toContain('Final synthesized answer.');
    expect(patch.content).not.toContain(STEP_LIMIT_NO_ANSWER_MARKER);
  });
});

// #487 F3 — the reconcile() / reconcileChat() ORCHESTRATORS. The individual
// clauses are exercised elsewhere; these pin the production orchestration the
// per-clause specs do not: the clause ORDER, the per-clause try/catch ISOLATION
// (one clause throwing must NOT abort the others), and reconcileChat() (which runs
// at the start of every turn and was entirely uncovered).
describe('AiChatService.reconcile / reconcileChat orchestrators (#487 F3)', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    // Silence the intentional clause-failure warnings (kept out of test output).
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  function makeService(opts: {
    messageRepo?: Record<string, jest.Mock>;
    runService?: Record<string, jest.Mock>;
  }) {
    const aiChatMessageRepo = {
      findStreamingWithTerminalRun: jest.fn(async () => []),
      stampTerminalIfStreaming: jest.fn(async () => undefined),
      sweepStreamingWithoutActiveRun: jest.fn(async () => 0),
      ...(opts.messageRepo ?? {}),
    };
    const aiChatRunService = opts.runService
      ? {
          zombieRunIds: jest.fn(() => []),
          settleZombie: jest.fn(async () => true),
          reconcileStaleRuns: jest.fn(async () => 0),
          ...opts.runService,
        }
      : undefined;
    const svc = new AiChatService(
      {} as never, // ai
      {} as never, // aiChatRepo
      aiChatMessageRepo as never,
      {} as never, // aiChatPageSnapshotRepo
      {} as never, // aiSettings
      {} as never, // tools
      {} as never, // mcpClients
      {} as never, // aiAgentRoleRepo
      {} as never, // pageRepo
      {} as never, // pageAccess
      {} as never, // environment
      {} as never, // streamRegistry
      aiChatRunService as never, // aiChatRunService (#487)
    );
    return { svc, aiChatMessageRepo, aiChatRunService };
  }

  it('reconcile() fires all four clauses IN ORDER (a -> b -> c -> d)', async () => {
    const order: string[] = [];
    const { svc } = makeService({
      messageRepo: {
        findStreamingWithTerminalRun: jest.fn(async () => {
          order.push('b:find');
          return [
            { messageId: 'm1', workspaceId: 'ws1', runStatus: 'succeeded' },
          ];
        }),
        stampTerminalIfStreaming: jest.fn(async () => {
          order.push('b:stamp');
        }),
        sweepStreamingWithoutActiveRun: jest.fn(async () => {
          order.push('d');
          return 0;
        }),
      },
      runService: {
        zombieRunIds: jest.fn(() => ['z1']),
        settleZombie: jest.fn(async () => {
          order.push('a');
          return true;
        }),
        reconcileStaleRuns: jest.fn(async () => {
          order.push('c');
          return 0;
        }),
      },
    });

    await svc.reconcile();

    expect(order).toEqual(['a', 'b:find', 'b:stamp', 'c', 'd']);
  });

  it('a clause that THROWS does not abort the remaining clauses (per-clause try/catch isolation)', async () => {
    const { svc, aiChatMessageRepo, aiChatRunService } = makeService({
      messageRepo: {
        // Clause (b) blows up mid-reconcile.
        findStreamingWithTerminalRun: jest.fn(async () => {
          throw new Error('clause b DB blip');
        }),
      },
      runService: {
        zombieRunIds: jest.fn(() => ['z1']),
      },
    });

    // reconcile() must SETTLE (the clause-b failure is swallowed), not reject.
    await expect(svc.reconcile()).resolves.toBeUndefined();

    // (a) ran before (b); crucially (c) and (d) STILL ran despite (b) throwing —
    // the property a missing try/catch would break. MUTATION-VERIFY: drop clause
    // (b)'s try/catch and this reddens (the throw propagates, skipping c + d).
    expect(aiChatRunService!.settleZombie).toHaveBeenCalled(); // (a)
    expect(aiChatRunService!.reconcileStaleRuns).toHaveBeenCalled(); // (c)
    expect(
      aiChatMessageRepo.sweepStreamingWithoutActiveRun,
    ).toHaveBeenCalled(); // (d)
  });

  it('reconcileChat() settles THIS chat\'s stuck streaming rows by their run status', async () => {
    const { svc, aiChatMessageRepo } = makeService({
      messageRepo: {
        findStreamingWithTerminalRun: jest.fn(async () => [
          { messageId: 'm1', workspaceId: 'ws1', runStatus: 'failed' },
          { messageId: 'm2', workspaceId: 'ws1', runStatus: 'succeeded' },
        ]),
      },
    });

    await svc.reconcileChat('chat-1', 'ws1');

    // Scoped to THIS chat and bounded at 50 (the user-facing opportunistic path).
    expect(
      aiChatMessageRepo.findStreamingWithTerminalRun,
    ).toHaveBeenCalledWith(50, { chatId: 'chat-1', workspaceId: 'ws1' });
    // failed-run -> 'error'; every other terminal status -> 'aborted'.
    expect(aiChatMessageRepo.stampTerminalIfStreaming).toHaveBeenCalledWith(
      'm1',
      'ws1',
      'error',
    );
    expect(aiChatMessageRepo.stampTerminalIfStreaming).toHaveBeenCalledWith(
      'm2',
      'ws1',
      'aborted',
    );
  });
});
