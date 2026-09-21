// #489 — client-parts validation + resilient history conversion.
//
// These unit tests exercise the two exported helpers against the REAL
// `convertToModelMessages` from `ai` (NOT a mock): a genuinely malformed part
// (a `null` element inside a parts array) makes the real converter throw
// ("Cannot read properties of null"), which is the actual production
// "bricked chat" mechanism this fix defends against. Asserting against the real
// converter (rather than a mock-shaped error) is the whole point — a mock would
// hide a version change in the converter's throw behaviour.
import { convertToModelMessages, type UIMessage } from 'ai';
import {
  sanitizeUserParts,
  convertHistoryResilient,
  TOOL_CONTEXT_OMITTED_MARKER,
} from './ai-chat.service';

type Row = Omit<UIMessage, 'id'> & { id: string };

describe('sanitizeUserParts (#489, branch: validation on receipt)', () => {
  it('keeps whitelisted text parts unchanged', () => {
    const drops: string[] = [];
    const out = sanitizeUserParts(
      [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ] as UIMessage['parts'],
      (t) => drops.push(t),
    );
    expect(out).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
    expect(drops).toEqual([]);
  });

  it('drops a non-text part (a tool-part in input-available) and reports its type', () => {
    const drops: string[] = [];
    const out = sanitizeUserParts(
      [
        { type: 'text', text: 'hi' },
        {
          type: 'tool-getPage',
          toolCallId: 't1',
          state: 'input-available',
          input: { pageId: 'p' },
        },
      ] as unknown as UIMessage['parts'],
      (t) => drops.push(t),
    );
    expect(out).toEqual([{ type: 'text', text: 'hi' }]);
    expect(drops).toEqual(['tool-getPage']);
  });

  it('drops a null part (the shape that would poison convertToModelMessages)', () => {
    const drops: string[] = [];
    const out = sanitizeUserParts(
      [{ type: 'text', text: 'hi' }, null] as unknown as UIMessage['parts'],
      (t) => drops.push(t),
    );
    expect(out).toEqual([{ type: 'text', text: 'hi' }]);
    expect(drops).toEqual(['(unknown)']);
  });

  it('returns undefined when nothing survives (so a null metadata is persisted)', () => {
    const out = sanitizeUserParts(
      [
        { type: 'tool-x', toolCallId: 't', state: 'input-available' },
      ] as unknown as UIMessage['parts'],
      () => undefined,
    );
    expect(out).toBeUndefined();
  });

  it('returns undefined for a non-array input', () => {
    expect(
      sanitizeUserParts(undefined as unknown as UIMessage['parts'], () => undefined),
    ).toBeUndefined();
  });
});

describe('convertHistoryResilient (#489, branches: happy + per-row degradation)', () => {
  it('happy path: healthy history converts identically to convertToModelMessages, no degrade', async () => {
    const history: Row[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ];
    const degrades: number[] = [];
    const out = await convertHistoryResilient(history, (i) => degrades.push(i));
    const expected = await convertToModelMessages(history as UIMessage[]);
    expect(out).toEqual(expected);
    expect(degrades).toEqual([]);
  });

  it('REAL poison: a null part throws in the batch converter but is isolated and degraded to a marker', async () => {
    // Sanity: the real converter genuinely throws on this shape.
    const poisoned: Row = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'earlier answer' },
        null,
      ] as unknown as UIMessage['parts'],
    };
    await expect(
      convertToModelMessages([poisoned as UIMessage]),
    ).rejects.toThrow();

    const history: Row[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
      poisoned,
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'second' }] },
    ];
    const degrades: number[] = [];
    const out = await convertHistoryResilient(history, (i) => degrades.push(i));

    // Only the poisoned row (index 1) is degraded.
    expect(degrades).toEqual([1]);
    // Healthy rows survive verbatim.
    const flat = JSON.stringify(out);
    expect(flat).toContain('first');
    expect(flat).toContain('second');
    // The degraded row carries its readable text AND the truncation marker so the
    // model sees that tool context was omitted (never a silent loss).
    expect(flat).toContain('earlier answer');
    expect(flat).toContain(TOOL_CONTEXT_OMITTED_MARKER);
    // The whole batch converted (3 model messages, none dropped).
    expect(out).toHaveLength(3);
  });

  it('a fully-poisoned row (no readable text) still degrades to just the marker', async () => {
    const history: Row[] = [
      {
        id: 'a1',
        role: 'assistant',
        parts: [null] as unknown as UIMessage['parts'],
      },
    ];
    const out = await convertHistoryResilient(history, () => undefined);
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out)).toContain(TOOL_CONTEXT_OMITTED_MARKER);
  });
});
