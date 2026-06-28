import { SandboxController } from './sandbox.controller';
import { SandboxEntry } from './sandbox.store';

// Capturing fake of the FastifyReply surface the controller uses:
// status()/header()/headers()/send(), all chainable.
function makeRes() {
  const sent: { status: number; headers: Record<string, any>; body: any } = {
    status: 200,
    headers: {},
    body: undefined,
  };
  const res: any = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    header(key: string, value: any) {
      sent.headers[key.toLowerCase()] = value;
      return res;
    },
    headers(obj: Record<string, any>) {
      for (const k of Object.keys(obj)) sent.headers[k.toLowerCase()] = obj[k];
      return res;
    },
    send(body?: any) {
      sent.body = body;
      return res;
    },
    _sent: sent,
  };
  return res;
}

function makeReq(headers: Record<string, any> = {}) {
  return { headers } as any;
}

const VALID_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function entry(buf: Buffer, mime: string, sha256: string): SandboxEntry {
  return { buf, mime, sha256, expiresAt: Date.now() + 60_000 };
}

describe('SandboxController', () => {
  it('serves 200 with body, Content-Type, Content-Length and sha256 ETag', async () => {
    const buf = Buffer.from('{"ok":true}', 'utf8');
    const sha = 'a'.repeat(64);
    const store = { get: jest.fn().mockReturnValue(entry(buf, 'application/json', sha)) };
    const controller = new SandboxController(store as any);
    const res = makeRes();

    await controller.get(VALID_ID, makeReq(), res);

    expect(store.get).toHaveBeenCalledWith(VALID_ID);
    expect(res._sent.status).toBe(200);
    expect(res._sent.headers['content-type']).toBe('application/json');
    expect(res._sent.headers['content-length']).toBe(buf.length);
    expect(res._sent.headers['etag']).toBe(`"${sha}"`);
    expect(res._sent.body).toBe(buf);
  });

  it('returns 404 for a missing/expired blob', async () => {
    const store = { get: jest.fn().mockReturnValue(undefined) };
    const controller = new SandboxController(store as any);
    const res = makeRes();

    await controller.get(VALID_ID, makeReq(), res);

    expect(res._sent.status).toBe(404);
    expect(res._sent.body).toBeUndefined();
  });

  it('returns 404 for a non-UUID id WITHOUT touching the store (anti-traversal)', async () => {
    const store = { get: jest.fn() };
    const controller = new SandboxController(store as any);
    const res = makeRes();

    await controller.get('../../etc/passwd', makeReq(), res);

    expect(store.get).not.toHaveBeenCalled();
    expect(res._sent.status).toBe(404);
  });

  it('returns 304 (no body) when If-None-Match matches the ETag', async () => {
    const sha = 'b'.repeat(64);
    const store = {
      get: jest.fn().mockReturnValue(entry(Buffer.from('x'), 'application/json', sha)),
    };
    const controller = new SandboxController(store as any);
    const res = makeRes();

    await controller.get(VALID_ID, makeReq({ 'if-none-match': `"${sha}"` }), res);

    expect(res._sent.status).toBe(304);
    expect(res._sent.body).toBeUndefined();
    expect(res._sent.headers['etag']).toBe(`"${sha}"`);
  });

  it('accepts a bare (unquoted) sha256 in If-None-Match too', async () => {
    const sha = 'c'.repeat(64);
    const store = {
      get: jest.fn().mockReturnValue(entry(Buffer.from('x'), 'application/json', sha)),
    };
    const controller = new SandboxController(store as any);
    const res = makeRes();

    await controller.get(VALID_ID, makeReq({ 'if-none-match': sha }), res);

    expect(res._sent.status).toBe(304);
  });

  it('serves 200 when If-None-Match does NOT match', async () => {
    const sha = 'd'.repeat(64);
    const store = {
      get: jest.fn().mockReturnValue(entry(Buffer.from('x'), 'application/json', sha)),
    };
    const controller = new SandboxController(store as any);
    const res = makeRes();

    await controller.get(VALID_ID, makeReq({ 'if-none-match': '"stale"' }), res);

    expect(res._sent.status).toBe(200);
  });

  it('returns 304 for a wildcard "*" If-None-Match', async () => {
    const sha = 'e'.repeat(64);
    const store = {
      get: jest.fn().mockReturnValue(entry(Buffer.from('x'), 'application/json', sha)),
    };
    const controller = new SandboxController(store as any);
    const res = makeRes();

    await controller.get(VALID_ID, makeReq({ 'if-none-match': '*' }), res);

    expect(res._sent.status).toBe(304);
  });

  it('returns 304 for a weak validator W/"<sha>"', async () => {
    const sha = 'f'.repeat(64);
    const store = {
      get: jest.fn().mockReturnValue(entry(Buffer.from('x'), 'application/json', sha)),
    };
    const controller = new SandboxController(store as any);
    const res = makeRes();

    await controller.get(VALID_ID, makeReq({ 'if-none-match': `W/"${sha}"` }), res);

    expect(res._sent.status).toBe(304);
  });

  it('returns 304 when a comma-separated If-None-Match list contains the sha', async () => {
    const sha = '1'.repeat(64);
    const store = {
      get: jest.fn().mockReturnValue(entry(Buffer.from('x'), 'application/json', sha)),
    };
    const controller = new SandboxController(store as any);
    const res = makeRes();

    await controller.get(
      VALID_ID,
      makeReq({ 'if-none-match': `"other", "${sha}"` }),
      res,
    );

    expect(res._sent.status).toBe(304);
  });

  it('sets a private, immutable Cache-Control with a max-age within the TTL on 200', async () => {
    const sha = '2'.repeat(64);
    // Known TTL: ~30s out, so the floored max-age must land within [0, 60].
    const e: SandboxEntry = {
      buf: Buffer.from('x'),
      mime: 'application/json',
      sha256: sha,
      expiresAt: Date.now() + 30_000,
    };
    const store = { get: jest.fn().mockReturnValue(e) };
    const controller = new SandboxController(store as any);
    const res = makeRes();

    await controller.get(VALID_ID, makeReq(), res);

    expect(res._sent.status).toBe(200);
    const cc = res._sent.headers['cache-control'] as string;
    expect(cc).toMatch(/^private, max-age=\d+, immutable$/);
    const maxAge = Number(cc.match(/max-age=(\d+)/)![1]);
    expect(maxAge).toBeGreaterThanOrEqual(0);
    expect(maxAge).toBeLessThanOrEqual(60);
  });
});
