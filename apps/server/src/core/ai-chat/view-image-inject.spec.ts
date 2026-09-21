/**
 * Unit tests for the cross-provider viewImage DELIVERY logic (#588 §2): the pure
 * prepareStep helpers that inject the image as an ephemeral user-role message and
 * evict a cache entry once the model has spoken about it. No LLM/provider needed.
 *
 *  - userImageMessage:  v6 image-part shape ({type:'image', image, mediaType}).
 *  - modelSpokeAboutItAfter:  deterministic from the finished-steps array.
 *  - injectViewImages:  inject-while-alive, evict-after-spoken, disjoint-key merge.
 */
import {
  userImageMessage,
  modelSpokeAboutItAfter,
  injectViewImages,
} from './ai-chat.service';
import type { ViewImageCache } from './tools/ai-chat-tools.service';

// A finished step carrying a tool call + optional assistant text.
function step(opts: {
  callId?: string;
  text?: string;
  viaContent?: boolean;
}): any {
  const s: any = { text: opts.text ?? '' };
  if (opts.callId && !opts.viaContent) {
    s.toolCalls = [{ toolCallId: opts.callId, toolName: 'viewImage', input: {} }];
  }
  if (opts.callId && opts.viaContent) {
    s.content = [{ type: 'tool-call', toolCallId: opts.callId, toolName: 'viewImage' }];
  }
  return s;
}

describe('userImageMessage (#588 v6 image part)', () => {
  it('emits a user message with a text lead-in and an image part using mediaType (NOT mimeType)', () => {
    const msg = userImageMessage({ data: 'BASE64', mediaType: 'image/png' });
    expect(msg.role).toBe('user');
    expect(msg.content).toEqual([
      { type: 'text', text: expect.any(String) },
      { type: 'image', image: 'BASE64', mediaType: 'image/png' },
    ]);
    const imagePart = msg.content[1] as Record<string, unknown>;
    // The field MUST be `mediaType`; a stray `mimeType` would make openai-compatible
    // providers silently drop the image.
    expect(imagePart).not.toHaveProperty('mimeType');
  });
});

describe('modelSpokeAboutItAfter (#588 eviction predicate)', () => {
  it('false when the call is not among the finished steps yet (just issued)', () => {
    expect(modelSpokeAboutItAfter('c1', [step({ text: 'hi' })])).toBe(false);
  });

  it('false when the call exists but NO later step has assistant text', () => {
    const steps = [step({ callId: 'c1' }), step({ callId: 'c2', text: '' })];
    expect(modelSpokeAboutItAfter('c1', steps)).toBe(false);
  });

  it('true when a step AFTER the call has non-empty assistant text', () => {
    const steps = [step({ callId: 'c1' }), step({ text: 'here is the answer' })];
    expect(modelSpokeAboutItAfter('c1', steps)).toBe(true);
  });

  it('ignores whitespace-only text on a later step (not "spoken")', () => {
    const steps = [step({ callId: 'c1' }), step({ text: '   \n ' })];
    expect(modelSpokeAboutItAfter('c1', steps)).toBe(false);
  });

  it('does NOT count text on the SAME step as the call (only strictly later steps)', () => {
    const steps = [step({ callId: 'c1', text: 'reasoning then call' })];
    expect(modelSpokeAboutItAfter('c1', steps)).toBe(false);
  });

  it('locates the call when it appears as a content tool-call part', () => {
    const steps = [
      step({ callId: 'c1', viaContent: true }),
      step({ text: 'answer' }),
    ];
    expect(modelSpokeAboutItAfter('c1', steps)).toBe(true);
  });

  it('false for empty/undefined steps', () => {
    expect(modelSpokeAboutItAfter('c1', [])).toBe(false);
    expect(modelSpokeAboutItAfter('c1', undefined)).toBe(false);
  });
});

describe('injectViewImages (#588 inject / evict / merge)', () => {
  const opts = (steps: any[], messages: any[] = [{ role: 'user', content: 'q' }]) => ({
    messages,
    steps,
  });

  it('empty cache => returns base unchanged (no injection)', () => {
    const base = { system: 'S' } as any;
    const cache: ViewImageCache = new Map();
    expect(injectViewImages(base, opts([]), cache)).toBe(base);
  });

  it('injects the image as a trailing user message while the entry is alive; does NOT evict', () => {
    const cache: ViewImageCache = new Map([
      ['c1', { data: 'IMG', mediaType: 'image/png' }],
    ]);
    // The call exists but the model has not spoken yet -> keep the entry.
    const res: any = injectViewImages(
      undefined,
      opts([step({ callId: 'c1' })], [{ role: 'user', content: 'q' }]),
      cache,
    );
    expect(res.messages).toHaveLength(2); // original + injected image
    const injected = res.messages[1];
    expect(injected.role).toBe('user');
    expect(injected.content[1]).toEqual({
      type: 'image',
      image: 'IMG',
      mediaType: 'image/png',
    });
    // Still alive: injected on the NEXT step too.
    expect(cache.has('c1')).toBe(true);
  });

  it('injects ONCE MORE then evicts on the step where the model has spoken (inject-then-delete)', () => {
    const cache: ViewImageCache = new Map([
      ['c1', { data: 'IMG', mediaType: 'image/png' }],
    ]);
    const steps = [step({ callId: 'c1' }), step({ text: 'the answer' })];
    const res: any = injectViewImages(undefined, opts(steps), cache);
    // The synthesis step is never starved: the image is still injected here...
    expect(res.messages).toHaveLength(2);
    // ...and evicted so no FURTHER step re-bills it.
    expect(cache.has('c1')).toBe(false);
  });

  it('disjoint-key merge preserves base activeTools/toolChoice/system alongside messages', () => {
    const base = {
      activeTools: ['viewImage', 'getPage'],
      toolChoice: 'none',
      system: 'SYS',
    } as any;
    const cache: ViewImageCache = new Map([
      ['c1', { data: 'IMG', mediaType: 'image/png' }],
    ]);
    const res: any = injectViewImages(base, opts([step({ callId: 'c1' })]), cache);
    // base keys survive (image rides to a toolChoice:'none' lockdown synthesis step)
    expect(res.activeTools).toEqual(['viewImage', 'getPage']);
    expect(res.toolChoice).toBe('none');
    expect(res.system).toBe('SYS');
    expect(res.messages).toHaveLength(2);
  });

  it('injects EVERY live entry (multiple concurrent viewImage calls)', () => {
    const cache: ViewImageCache = new Map([
      ['c1', { data: 'A', mediaType: 'image/png' }],
      ['c2', { data: 'B', mediaType: 'image/jpeg' }],
    ]);
    const res: any = injectViewImages(
      undefined,
      opts([step({ callId: 'c1' }), step({ callId: 'c2' })]),
      cache,
    );
    expect(res.messages).toHaveLength(3); // original + 2 images
  });
});
