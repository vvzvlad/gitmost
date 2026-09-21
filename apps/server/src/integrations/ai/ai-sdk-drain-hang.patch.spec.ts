import { readFileSync } from 'fs';
import { EventEmitter } from 'node:events';
import { streamText } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

/**
 * Regression tests for the writeToServerResponse drain-hang fix in
 * patches/ai@6.0.134.patch (#486, commit 6).
 *
 * Unpatched ai@6.0.134's writeToServerResponse awaits ONLY `once("drain")` when
 * response.write() returns false (backpressure). If the client disconnects
 * mid-write the socket never drains, so that await never resolves: the read loop
 * parks FOREVER, its `finally { response.end() }` is unreachable, and the stream
 * reader + buffered chunks are pinned until process restart. In autonomous mode
 * the run keeps producing output after the disconnect, so EVERY mid-run
 * disconnect leaks a hung pipe. The patch races drain against close/error, and on
 * a terminal socket event cancels the reader and breaks so `finally` always runs.
 *
 * This drives the REAL patched writeToServerResponse through the public
 * pipeUIMessageStreamToResponse API with a response that never drains and closes
 * mid-write — exactly the leak scenario.
 */

/** A ServerResponse-like emitter whose first write() stalls (returns false) and
 *  then "closes" like a disconnecting client — never firing 'drain'. */
class DisconnectingResponse extends EventEmitter {
  ended = false;
  writeCount = 0;
  statusCode = 200;
  writableEnded = false;
  destroyed = false;
  writeHead(): this {
    return this;
  }
  setHeader(): void {}
  flushHeaders(): void {}
  write(): boolean {
    this.writeCount++;
    if (this.writeCount === 1) {
      // Simulate the client vanishing mid-write: backpressure (false) and then a
      // 'close' on the next tick, and CRUCIALLY never a 'drain'. Unpatched, the
      // loop would await drain forever here.
      setImmediate(() => this.emit('close'));
      return false;
    }
    return true;
  }
  end(): void {
    this.ended = true;
    this.writableEnded = true;
    this.emit('finish');
  }
}

function makeModel() {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: '1' },
          { type: 'text-delta' as const, id: '1', delta: 'hello ' },
          { type: 'text-delta' as const, id: '1', delta: 'world' },
          { type: 'text-end' as const, id: '1' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  });
}

describe('ai@6.0.134 pnpm patch: writeToServerResponse drain-hang (#486)', () => {
  it('ends the response (does NOT hang) when the socket closes mid-write without draining', async () => {
    const result = streamText({ model: makeModel(), prompt: 'hi' });
    const res = new DisconnectingResponse();
    // Drain the SDK stream independently, like the production detached path.
    void result.consumeStream({ onError: () => undefined });
    result.pipeUIMessageStreamToResponse(res as never);

    // TRIPWIRE: the patched loop exits on 'close' and runs finally -> end().
    // Unpatched, it awaits 'drain' forever and this never becomes true.
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (res.ended) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() - started > 3000) {
          clearInterval(poll);
          reject(new Error('writeToServerResponse hung: response never ended'));
        }
      }, 20);
    });

    expect(res.ended).toBe(true);
  });

  it('does not emit an unhandledRejection when the fire-and-forget read() throws', async () => {
    // The patch swallows read()'s rejection (fire-and-forget) with a log instead
    // of letting it surface as a process-killing unhandledRejection.
    const rejections: unknown[] = [];
    const onUnhandled = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onUnhandled);
    // Silence the patch's diagnostic console.error for the throwing read().
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = streamText({ model: makeModel(), prompt: 'hi' });
      const res = new DisconnectingResponse();
      void result.consumeStream({ onError: () => undefined });
      result.pipeUIMessageStreamToResponse(res as never);
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      process.off('unhandledRejection', onUnhandled);
      errSpy.mockRestore();
    }
    expect(rejections).toEqual([]);
  });

  it('both installed dist builds (CJS and ESM) carry the #486 patch marker', () => {
    const cjsPath = require.resolve('ai');
    const mjsPath = cjsPath.replace(/index\.js$/, 'index.mjs');
    expect(cjsPath).toMatch(/index\.js$/);
    expect(readFileSync(cjsPath, 'utf8')).toContain('PATCH(docmost #486)');
    expect(readFileSync(mjsPath, 'utf8')).toContain('PATCH(docmost #486)');
  });
});
