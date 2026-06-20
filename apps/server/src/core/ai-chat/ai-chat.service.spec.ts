import {
  compactToolOutput,
  assistantParts,
  serializeSteps,
  rowToUiMessage,
  prepareAgentStep,
  buildErrorAssistantRecord,
  MAX_AGENT_STEPS,
  FINAL_STEP_INSTRUCTION,
} from './ai-chat.service';
import type { AiChatMessage } from '@docmost/db/types/entity.types';

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
        toolCalls: [{ toolCallId: 'c1', toolName: 'getPage', input: { id: 'p1' } }],
        toolResults: [{ toolCallId: 'c1', toolName: 'getPage', output: { title: 'T' } }],
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
        toolCalls: [{ toolCallId: 'c9', toolName: 'insertNode', input: { node: {} } }],
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
      (p) => typeof p.type === 'string' && (p.type as string).startsWith('tool-'),
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
 * Unit test for buildErrorAssistantRecord: the pure helper that shapes the
 * assistant-message record persisted on a first-turn (or any) stream failure.
 * The streamText onError callback builds the formatted error text via
 * describeProviderError (tested separately) and hands it to this helper; pinning
 * the record shape here covers the persist-assistant-on-error logic without
 * having to seam streamText itself.
 */
describe('buildErrorAssistantRecord', () => {
  it('records an empty turn with the error text in metadata (finishReason=error)', () => {
    const rec = buildErrorAssistantRecord('401: Unauthorized');
    expect(rec).toEqual({
      text: '',
      toolCalls: null,
      metadata: { finishReason: 'error', parts: [], error: '401: Unauthorized' },
    });
  });

  it('always produces empty text + empty parts so a failed turn is still recorded', () => {
    const rec = buildErrorAssistantRecord('boom');
    // No partial text and no UI parts: the turn exists in history but renders as
    // an error, with the cause preserved in metadata.error.
    expect(rec.text).toBe('');
    expect(rec.metadata.parts).toEqual([]);
    expect(rec.toolCalls).toBeNull();
    expect(rec.metadata.error).toBe('boom');
  });
});
