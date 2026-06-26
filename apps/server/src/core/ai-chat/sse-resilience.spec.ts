import type { ServerResponse } from 'node:http';
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

  it('does not write when the response is already ended', () => {
    const { res } = makeRes({ writableEnded: true });
    startSseHeartbeat(res as unknown as ServerResponse, 15_000);

    jest.advanceTimersByTime(45_000);
    expect(res.write).not.toHaveBeenCalled();
  });

  it('does not write when the socket is destroyed', () => {
    const { res } = makeRes({ destroyed: true });
    startSseHeartbeat(res as unknown as ServerResponse, 15_000);

    jest.advanceTimersByTime(45_000);
    expect(res.write).not.toHaveBeenCalled();
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
