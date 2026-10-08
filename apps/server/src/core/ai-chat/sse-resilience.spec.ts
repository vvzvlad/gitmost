import * as http from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  startSseHeartbeat,
  stripStreamingHopByHopHeaders,
} from './sse-resilience';

/**
 * Unit tests for the SSE streaming resilience helpers.
 *
 * startSseHeartbeat keeps a hijacked SSE response progressing during silent
 * tool/think gaps by writing an SSE comment line on a timer (Safari/proxy idle
 * timeout). stripStreamingHopByHopHeaders scrubs the hop-by-hop
 * Connection/Keep-Alive headers the AI SDK adds before the response head is
 * written (Safari rejects them over HTTP/2).
 */
describe('startSseHeartbeat', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const makeRes = (
    overrides: Partial<{ writableEnded: boolean; destroyed: boolean }> = {},
  ) => {
    const handlers: Record<string, () => void> = {};
    const res = {
      writableEnded: false,
      destroyed: false,
      write: jest.fn(),
      once: jest.fn((event: string, handler: () => void) => {
        handlers[event] = handler;
        return res;
      }),
      ...overrides,
    };
    return { res, handlers };
  };

  it('writes an SSE comment ping each interval', () => {
    const { res } = makeRes();
    startSseHeartbeat(res as unknown as ServerResponse, 15_000);

    jest.advanceTimersByTime(15_000);
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenLastCalledWith(': ping\n\n');

    jest.advanceTimersByTime(15_000);
    expect(res.write).toHaveBeenCalledTimes(2);
  });

  it('stops pinging after the returned stop() is called', () => {
    const { res } = makeRes();
    const stop = startSseHeartbeat(res as unknown as ServerResponse, 15_000);

    jest.advanceTimersByTime(15_000);
    expect(res.write).toHaveBeenCalledTimes(1);

    stop();
    jest.advanceTimersByTime(60_000);
    expect(res.write).toHaveBeenCalledTimes(1);
  });

  it('stops pinging when the registered finish/close handler fires', () => {
    const { res, handlers } = makeRes();
    startSseHeartbeat(res as unknown as ServerResponse, 15_000);

    jest.advanceTimersByTime(15_000);
    expect(res.write).toHaveBeenCalledTimes(1);

    // Both 'close' and 'finish' are registered with the same stop handler.
    expect(handlers.close).toBeDefined();
    expect(handlers.finish).toBeDefined();
    handlers.finish();

    jest.advanceTimersByTime(60_000);
    expect(res.write).toHaveBeenCalledTimes(1);
  });

  it('does not write once the response has ended', () => {
    const { res } = makeRes();
    startSseHeartbeat(res as unknown as ServerResponse, 15_000);
    res.writableEnded = true;

    jest.advanceTimersByTime(45_000);
    expect(res.write).not.toHaveBeenCalled();
  });

  it('does not write once the socket is destroyed', () => {
    const { res } = makeRes();
    startSseHeartbeat(res as unknown as ServerResponse, 15_000);
    res.destroyed = true;

    jest.advanceTimersByTime(45_000);
    expect(res.write).not.toHaveBeenCalled();
  });

  it('does not arm on a response that is already gone', () => {
    const { res } = makeRes({ destroyed: true });
    startSseHeartbeat(res as unknown as ServerResponse, 15_000);
    expect(res.once).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});

// #717 on a REALLY closed response: the client left before the stream started,
// so 'close' already fired and will not fire again. A timer started now would
// never be cleared and would pin the dead response in memory forever.
describe('startSseHeartbeat on a response whose client already left', () => {
  it('schedules no timer', async () => {
    let server: http.Server | undefined;
    const res = await new Promise<ServerResponse>((resolve) => {
      let client: http.ClientRequest;
      server = http.createServer((req, serverRes) => {
        req.resume();
        serverRes.once('close', () => resolve(serverRes));
        client.destroy();
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server!.address() as AddressInfo;
        client = http.request({ port, host: '127.0.0.1', method: 'POST' });
        client.on('error', () => undefined);
        client.end('{}');
      });
    });
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    try {
      expect(res.destroyed).toBe(true);
      startSseHeartbeat(res, 10);
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
      await new Promise((r) => server!.close(r));
    }
  });
});

describe('stripStreamingHopByHopHeaders', () => {
  it('removes connection/keep-alive headers but keeps the rest', () => {
    const writeHead = jest.fn();
    const res = { writeHead } as unknown as ServerResponse;

    stripStreamingHopByHopHeaders(res);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      connection: 'keep-alive',
      'Keep-Alive': 'timeout=5',
      'x-accel-buffering': 'no',
    });

    expect(writeHead).toHaveBeenCalledTimes(1);
    const [statusCode, headers] = writeHead.mock.calls[0] as [
      number,
      Record<string, unknown>,
    ];
    expect(statusCode).toBe(200);
    expect(headers).not.toHaveProperty('connection');
    expect(headers).not.toHaveProperty('Keep-Alive');
    expect(headers).toEqual({
      'content-type': 'text/event-stream',
      'x-accel-buffering': 'no',
    });
  });

  it('leaves a header-less writeHead(statusCode) call untouched', () => {
    const writeHead = jest.fn();
    const res = { writeHead } as unknown as ServerResponse;

    stripStreamingHopByHopHeaders(res);
    res.writeHead(204);

    expect(writeHead).toHaveBeenCalledWith(204);
  });
});
