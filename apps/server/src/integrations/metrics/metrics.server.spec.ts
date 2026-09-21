import { get as httpGet } from 'node:http';
import { AddressInfo } from 'node:net';
import { createServer } from 'node:http';

// Drive the metrics HTTP server without the load-time METRICS_PORT gate: mock the
// registry so isMetricsEnabled()/getMetricsRegistry() are always satisfied. What
// we assert is observed over a REAL socket (bind address, status codes), not on
// the mock.
jest.mock('./metrics.registry', () => ({
  isMetricsEnabled: () => true,
  getMetricsRegistry: () => ({
    metrics: async () => '# HELP up test\nup 1\n',
    contentType: 'text/plain; version=0.0.4',
  }),
}));

import {
  startMetricsServer,
  closeMetricsServer,
  resolveMetricsBind,
  resolveMetricsToken,
} from './metrics.server';

/** Find a free TCP port (the metrics server requires METRICS_PORT > 0). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** Minimal GET against 127.0.0.1:port with optional Authorization header. */
function req(
  port: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = httpGet(
      { host: '127.0.0.1', port, path: '/metrics', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body }),
        );
      },
    );
    r.on('error', reject);
  });
}

describe('metrics server bind + auth (#486)', () => {
  const saved = {
    bind: process.env.METRICS_BIND,
    token: process.env.METRICS_TOKEN,
    port: process.env.METRICS_PORT,
  };

  afterEach(async () => {
    await closeMetricsServer();
    process.env.METRICS_BIND = saved.bind;
    process.env.METRICS_TOKEN = saved.token;
    process.env.METRICS_PORT = saved.port;
    delete process.env.METRICS_BIND;
    delete process.env.METRICS_TOKEN;
  });

  describe('resolveMetricsBind', () => {
    it('defaults to loopback 127.0.0.1', () => {
      delete process.env.METRICS_BIND;
      expect(resolveMetricsBind()).toBe('127.0.0.1');
    });
    it('honours the METRICS_BIND override', () => {
      process.env.METRICS_BIND = '0.0.0.0';
      expect(resolveMetricsBind()).toBe('0.0.0.0');
    });
    it('treats a blank override as unset (loopback)', () => {
      process.env.METRICS_BIND = '   ';
      expect(resolveMetricsBind()).toBe('127.0.0.1');
    });
  });

  describe('resolveMetricsToken', () => {
    it('is null when unset', () => {
      delete process.env.METRICS_TOKEN;
      expect(resolveMetricsToken()).toBeNull();
    });
    it('returns the trimmed token when set', () => {
      process.env.METRICS_TOKEN = ' s3cret ';
      expect(resolveMetricsToken()).toBe('s3cret');
    });
  });

  it('binds to loopback by default and serves /metrics without auth when no token', async () => {
    delete process.env.METRICS_BIND;
    delete process.env.METRICS_TOKEN;
    const port = await freePort();
    process.env.METRICS_PORT = String(port);

    const server = startMetricsServer();
    expect(server).not.toBeNull();
    await new Promise<void>((resolve) => {
      if (server!.listening) resolve();
      else server!.once('listening', () => resolve());
    });
    // OBSERVABLE: the listener bound to loopback, not 0.0.0.0.
    expect((server!.address() as AddressInfo).address).toBe('127.0.0.1');

    const res = await req(port);
    expect(res.status).toBe(200);
    expect(res.body).toContain('up 1');
  });

  it('rejects unauthenticated scrapes with 401 and accepts the exact Bearer token', async () => {
    delete process.env.METRICS_BIND;
    process.env.METRICS_TOKEN = 'topsecret';
    const port = await freePort();
    process.env.METRICS_PORT = String(port);

    const server = startMetricsServer();
    expect(server).not.toBeNull();

    // No auth -> 401.
    const noAuth = await req(port);
    expect(noAuth.status).toBe(401);

    // Wrong token, DIFFERENT length -> 401 (short-circuits on the length guard).
    const wrong = await req(port, { authorization: 'Bearer nope' });
    expect(wrong.status).toBe(401);

    // Wrong token, SAME length -> 401. This drives the timingSafeEqual compare
    // itself (the length guard passes: 'Bearer topsecreX' has the same length as
    // 'Bearer topsecret'). Pins the constant-time compare: a regression that made
    // it return true would let this equal-length wrong token through — the
    // different-length case above would NOT catch that.
    const sameLen = await req(port, { authorization: 'Bearer topsecreX' });
    expect(sameLen.status).toBe(401);

    // Correct token -> 200 with the metrics body.
    const ok = await req(port, { authorization: 'Bearer topsecret' });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('up 1');
  });
});
