import { ForbiddenException } from '@nestjs/common';
import {
  AiChatService,
  compactToolOutput,
  assistantParts,
  serializeSteps,
  rowToUiMessage,
  prepareAgentStep,
  flushAssistant,
  chatStreamMetadata,
  accumulateStepUsage,
  isInterruptResume,
  sameInstant,
  MAX_AGENT_STEPS,
  FINAL_STEP_INSTRUCTION,
} from './ai-chat.service';
import type { AiChatMessage, Workspace } from '@docmost/db/types/entity.types';
import { buildSystemPrompt } from './ai-chat.prompt';
import type { McpClientsService } from './external-mcp/mcp-clients.service';

/**
 * Unit tests for compactToolOutput: the pure helper that shrinks LARGE tool
 * outputs before they are persisted (and re-sent to the provider on later
 * turns). The contract is: small outputs pass through unchanged (by identity);
 * large outputs keep their shape and small scalar fields (id/title/pageId — the
 * client reads these to render citations) while big payloads are truncated.
 */
describe('compactToolOutput', () => {
  it('returns a small object unchanged (by identity)', () => {
    const small = { id: 'p1', title: 'Hello', trashed: true };
    expect(compactToolOutput(small)).toBe(small);
  });

  it('truncates a large getPage-shaped markdown body but keeps the title', () => {
    const big = 'x'.repeat(20000);
    const result = compactToolOutput({ title: 'T', markdown: big }) as {
      title: string;
      markdown: string;
    };
    // Shallow scalar field is preserved (citations depend on it).
    expect(result.title).toBe('T');
    // The big payload is shrunk far below the original size.
    expect(result.markdown.length).toBeLessThan(20000);
    expect(result.markdown).toContain('[truncated');
  });

  it('caps a long array and appends a single truncation marker', () => {
    // 200 small objects, each padded so the total serialized size > 4000 bytes.
    const long = Array.from({ length: 200 }, (_, i) => ({
      id: 'n' + i,
      pad: 'y'.repeat(40),
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
    // string at the bottom so the total serialized size exceeds the threshold.
    let nested: Record<string, unknown> = { leaf: 'z'.repeat(8000) };
    for (let i = 0; i < 20; i++) {
      nested = { child: nested };
    }
    const result = compactToolOutput(nested);
    expect(JSON.stringify(result)).toContain('nested content omitted');
  });

  it('produces a much smaller JSON than the original for a large input', () => {
    const big = 'x'.repeat(20000);
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

describe('serializeSteps', () => {
  it('returns null when there are no calls or results', () => {
    expect(serializeSteps([])).toBeNull();
  });

  it('flattens calls and results into a compact trace', () => {
    const trace = serializeSteps([
      {
        toolCalls: [{ toolName: 'getPage', input: { id: 'p1' } }],
        toolResults: [{ toolName: 'getPage', output: { title: 'T' } }],
      },
    ]) as Array<Record<string, unknown>>;
    expect(trace).toHaveLength(2);
    expect(trace[0]).toEqual({ toolName: 'getPage', input: { id: 'p1' } });
    expect(trace[1]).toEqual({ toolName: 'getPage', output: { title: 'T' } });
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
 * overrides for the agent loop. Early steps return undefined (default
 * behavior); the final allowed step (stepNumber === MAX_AGENT_STEPS - 1) forces
 * a text-only synthesis answer (toolChoice 'none') with the FINAL_STEP_INSTRUCTION
 * appended onto — not replacing — the original system prompt.
 */
describe('prepareAgentStep', () => {
  it('returns undefined for the first step', () => {
    expect(prepareAgentStep(0, 'SYS')).toBeUndefined();
  });

  it('returns undefined for a non-final step (just before the last)', () => {
    expect(prepareAgentStep(MAX_AGENT_STEPS - 2, 'SYS')).toBeUndefined();
  });

  it('forces a text-only synthesis on the final allowed step', () => {
    const result = prepareAgentStep(MAX_AGENT_STEPS - 1, 'SYS');
    expect(result).toBeDefined();
    expect(result?.toolChoice).toBe('none');
    // The original persona is preserved (prefix), not replaced.
    expect(result?.system.startsWith('SYS')).toBe(true);
    // The synthesis instruction is appended.
    expect(result?.system).toContain(FINAL_STEP_INSTRUCTION);
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
    // updatedAt (#274 page-change fast path) is carried through from the DB row.
    expect(result).toEqual({ id: 'p-1', title: 'Real Title B', updatedAt });
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
    });
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
    expect(typeof row.contentHash).toBe('string');
  });

  it('snapshot: skips the write when the page was deleted during the turn', async () => {
    const { svc, store } = makeService({ exportMd: 'X', page: null });
    await snapshot(svc);
    expect(store.get('c1|p1')).toBeUndefined();
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
    prev: { role: string; status?: string | null } | null,
  ): Array<{ role: string; status?: string | null }> =>
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
});
