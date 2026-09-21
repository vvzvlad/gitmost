import { readFileSync } from 'fs';
import { streamText, Output } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

/**
 * Regression tests for patches/ai@6.0.134.patch (server heap OOM on long
 * autonomous agent runs, #184).
 *
 * Unpatched ai@6.0.134 substitutes the default text() output strategy even
 * when the caller passes NO `output` option. Its createOutputTransformStream
 * then accumulates the ENTIRE turn text and, on EVERY text-delta, enqueues a
 * flat snapshot of all text so far as `partialOutput` (O(n^2) memory). Those
 * snapshots pile up in the never-consumed leftover tee() branch of
 * DefaultStreamTextResult.baseStream, which is what OOM'd production during a
 * ~28k-chunk agent turn. The pnpm patch skips partialOutput production
 * entirely when no output strategy was requested, while keeping per-delta
 * streaming granularity.
 */
describe('ai@6.0.134 pnpm patch: no partialOutput accumulation without an output strategy', () => {
  const makeModel = () =>
    new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: '1' },
            { type: 'text-delta' as const, id: '1', delta: 'Hello' },
            { type: 'text-delta' as const, id: '1', delta: ', ' },
            { type: 'text-delta' as const, id: '1', delta: 'world!' },
            { type: 'text-end' as const, id: '1' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ],
        }),
      }),
    });

  it('preserves per-delta streaming granularity in textStream', async () => {
    const result = streamText({ model: makeModel(), prompt: 'hi' });

    const deltas: string[] = [];
    for await (const delta of result.textStream) {
      deltas.push(delta);
    }

    // The patch must NOT coalesce or drop deltas: three model deltas arrive
    // as three separate textStream chunks.
    expect(deltas).toEqual(['Hello', ', ', 'world!']);
  });

  it('emits NO partialOutput values when the caller did not request an output strategy', async () => {
    const result = streamText({ model: makeModel(), prompt: 'hi' });

    // Fully consume the primary stream first (mirrors production usage).
    for await (const _ of result.textStream) {
      // drain
    }

    const partials: unknown[] = [];
    for await (const partial of result.experimental_partialOutputStream) {
      partials.push(partial);
    }

    // TRIPWIRE: on unpatched ai@6.0.134 the default text() output strategy
    // yields one cumulative partial per text-delta here (['Hello', 'Hello, ',
    // 'Hello, world!']). An empty stream proves the patch is applied and no
    // cumulative snapshots are being produced (and thus none can pile up in
    // the leftover internal tee branch).
    expect(partials).toEqual([]);
  });

  it('preserves cumulative partialOutput when the caller DOES request an output strategy', async () => {
    // PRESERVE-BRANCH GUARD: the patch only short-circuits partialOutput when
    // `output == null`. When an output strategy IS set (here Output.text()),
    // createOutputTransformStream must fall through to the ORIGINAL code path
    // and keep publishing cumulative snapshots, so object/text-output consumers
    // behave byte-identically to unpatched ai. A careless re-port that routed
    // output-set calls into the skip branch would leave partialOutput empty and
    // silently break those consumers — this test is the tripwire for that.
    const result = streamText({
      model: makeModel(),
      prompt: 'hi',
      experimental_output: Output.text(),
    });

    // Drain the primary stream fully and accumulate the complete output text.
    let fullText = '';
    for await (const delta of result.textStream) {
      fullText += delta;
    }

    const partials: string[] = [];
    for await (const partial of result.experimental_partialOutputStream) {
      partials.push(partial);
    }

    // With a strategy set, partialOutput must be PRESERVED (non-empty) and
    // cumulative: the last emitted partial equals the full accumulated text.
    expect(partials.length).toBeGreaterThan(0);
    expect(partials[partials.length - 1]).toBe(fullText);
    expect(fullText).toBe('Hello, world!');
  });

  it('both installed dist builds (CJS and ESM) carry the patch marker', () => {
    // Secondary guard: pins the patch to BOTH bundles the SDK ships, since
    // the NestJS server consumes CJS while other tooling may load ESM.
    const cjsPath = require.resolve('ai');
    const mjsPath = cjsPath.replace(/index\.js$/, 'index.mjs');
    expect(cjsPath).toMatch(/index\.js$/);
    expect(readFileSync(cjsPath, 'utf8')).toContain('PATCH(docmost');
    expect(readFileSync(mjsPath, 'utf8')).toContain('PATCH(docmost');
  });
});
