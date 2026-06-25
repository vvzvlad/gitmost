import { ForbiddenException } from '@nestjs/common';
import {
  AiChatService,
  compactToolOutput,
  assistantParts,
  serializeSteps,
  rowToUiMessage,
  prepareAgentStep,
  buildPartialAssistantRecord,
  chatStreamMetadata,
  accumulateStepUsage,
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

  it('pins the off-by-one boundary (MAX-2 is not final, MAX-1 is)', () => {
    // Boundary expressed via the constant, not a hardcoded 18/19, so the test
    // tracks MAX_AGENT_STEPS if the cap ever changes.
    expect(prepareAgentStep(MAX_AGENT_STEPS - 2, 'SYS')).toBeUndefined();
    const atBoundary = prepareAgentStep(MAX_AGENT_STEPS - 1, 'SYS');
    expect(atBoundary).toBeDefined();
    expect(atBoundary?.toolChoice).toBe('none');
  });
});

/**
 * Unit test for buildPartialAssistantRecord: the pure helper that shapes the
 * assistant-message record persisted on a partial/failed turn (the streamText
 * onError / onAbort paths). It captures the PARTIAL answer the user already saw
 * (finished steps' text + tool parts, plus the in-progress step's text) so a
 * provider error / disconnect no longer throws the streamed answer away. Pinning
 * the record shape here covers the persist-partial logic without seaming
 * streamText itself.
 */
describe('buildPartialAssistantRecord', () => {
  type AnyPart = Record<string, unknown>;

  it('records an empty turn with the error text (preserves old behavior)', () => {
    const rec = buildPartialAssistantRecord(
      [],
      '',
      'error',
      '401: Unauthorized',
    );
    expect(rec).toEqual({
      text: '',
      toolCalls: null,
      metadata: {
        finishReason: 'error',
        parts: [],
        error: '401: Unauthorized',
      },
    });
  });

  it('persists in-progress text (no finished steps) as the partial answer', () => {
    const rec = buildPartialAssistantRecord(
      [],
      'partial answer',
      'error',
      'boom',
    );
    expect(rec.text).toBe('partial answer');
    expect(rec.metadata.parts).toEqual([
      { type: 'text', text: 'partial answer' },
    ]);
    expect(rec.metadata.error).toBe('boom');
  });

  it('combines a finished tool step with trailing in-progress text', () => {
    const steps = [
      {
        text: 'looked it up',
        toolCalls: [
          { toolCallId: 'c1', toolName: 'getPage', input: { id: 'p1' } },
        ],
        toolResults: [
          { toolCallId: 'c1', toolName: 'getPage', output: { title: 'T' } },
        ],
      },
    ];
    const rec = buildPartialAssistantRecord(
      steps,
      ' and then',
      'error',
      'boom',
    );
    const parts = rec.metadata.parts as AnyPart[];
    // The finished step's text part is present.
    expect(parts).toContainEqual({ type: 'text', text: 'looked it up' });
    // The paired tool call+result becomes an output-available part.
    const toolPart = parts.find((p) => p.type === 'tool-getPage');
    expect(toolPart).toBeDefined();
    expect(toolPart!.state).toBe('output-available');
    // The in-progress text is appended LAST so the parts match the stream order.
    expect(parts[parts.length - 1]).toEqual({
      type: 'text',
      text: ' and then',
    });
    expect(rec.text).toBe('looked it up and then');
    expect(rec.toolCalls).not.toBeNull();
    expect(rec.metadata.error).toBe('boom');
  });

  it('omits the error key on the abort path (no errorText)', () => {
    const rec = buildPartialAssistantRecord([], 'half', 'aborted');
    expect(rec.metadata.finishReason).toBe('aborted');
    expect('error' in rec.metadata).toBe(false);
    expect(rec.text).toBe('half');
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
    page?: { id: string; workspaceId: string; title: string | null } | null;
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

  it('uses the AUTHORITATIVE DB title, IGNORING the client-supplied title', async () => {
    const svc = makeService({
      page: { id: 'p-1', workspaceId: 'ws-1', title: 'Real Title B' },
      canView: true,
    });
    // The client claims it is on "Page A" but the id points at page B.
    const result = await call(svc, { id: 'p-1', title: 'Page A' });
    expect(result).toEqual({ id: 'p-1', title: 'Real Title B' });
  });

  it('coerces a null DB title to an empty string', async () => {
    const svc = makeService({
      page: { id: 'p-1', workspaceId: 'ws-1', title: null },
      canView: true,
    });
    expect(await call(svc, { id: 'p-1' })).toEqual({ id: 'p-1', title: '' });
  });
});
