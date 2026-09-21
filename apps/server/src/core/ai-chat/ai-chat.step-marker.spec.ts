import { flushAssistant } from './ai-chat.service';

/**
 * #491 STEP MARKER — `metadata.stepsPersisted` is written by the SAME flush that
 * builds `metadata.parts`, so the marker can never disagree with the persisted
 * parts (the step-alignment anchor the resume stack builds on). These are
 * PROPERTY tests: they assert the marker tracks the number of FINISHED steps for
 * every flush shape.
 */

// A finished step carrying one line of text and one tool call/result.
function step(i: number) {
  return {
    text: `step ${i}`,
    toolCalls: [
      { toolCallId: `c${i}`, toolName: 'getPage', input: { id: `p${i}` } },
    ],
    toolResults: [
      { toolCallId: `c${i}`, toolName: 'getPage', output: { title: `T${i}` } },
    ],
  };
}

describe('flushAssistant step marker (#491)', () => {
  it('seed (no steps) → stepsPersisted 0', () => {
    const f = flushAssistant([], '', 'streaming');
    expect(f.metadata.stepsPersisted).toBe(0);
  });

  it('PROPERTY: stepsPersisted equals the number of FINISHED steps, for any N', () => {
    for (let n = 0; n <= 6; n++) {
      const steps = Array.from({ length: n }, (_, i) => step(i));
      const f = flushAssistant(steps, '', 'streaming');
      expect(f.metadata.stepsPersisted).toBe(n);
      // ...and the parts actually contain those N steps' text (marker agrees with
      // the persisted parts — the atomicity the whole design relies on).
      const parts = f.metadata.parts as Array<Record<string, unknown>>;
      const textParts = parts.filter((p) => p.type === 'text');
      expect(textParts).toHaveLength(n);
    }
  });

  it('an in-progress trailing partial does NOT increment the marker', () => {
    // 2 finished steps + a partial (not-yet-finished) trailing text: the marker
    // counts only the CONFIRMED step boundaries, not the partial.
    const f = flushAssistant([step(0), step(1)], 'partial third step', 'error', {
      error: 'boom',
    });
    expect(f.metadata.stepsPersisted).toBe(2);
    // The partial text IS persisted in parts (so the user sees it), but it is not a
    // counted step.
    const parts = f.metadata.parts as Array<Record<string, unknown>>;
    expect(parts[parts.length - 1]).toEqual({
      type: 'text',
      text: 'partial third step',
    });
  });

  it('terminal completed flush counts all finished steps', () => {
    const f = flushAssistant([step(0), step(1), step(2)], '', 'completed', {
      finishReason: 'stop',
    });
    expect(f.metadata.stepsPersisted).toBe(3);
  });
});
