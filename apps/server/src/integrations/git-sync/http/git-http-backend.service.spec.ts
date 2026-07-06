// Unit tests for the pure CGI-response helpers used by GitHttpBackendService.
// The header/body split MUST treat the body as binary (Buffer) and never
// stringify it; the Status: header sets the HTTP status (default 200).
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

// Mock the spawn boundary so run() never launches a real `git http-backend`; the
// fake child lets us drive every stdout/stderr/error/close branch by hand.
jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
// vaultGitEnv just builds the CGI env overlay; stub it to a passthrough so the
// service runs without the real engine. The service loads it at runtime via the
// `loadGitSync()` bridge (the ESM `@docmost/git-sync` package cannot be
// `require()`d under jest), so we mock that loader rather than the package.
jest.mock('../git-sync.loader', () => ({
  loadGitSync: jest.fn(async () => ({
    vaultGitEnv: (overlay: Record<string, string>) => overlay,
  })),
}));

import {
  parseCgiResponse,
  splitCgiBuffer,
  buildGitBackendCgiEnv,
  GitHttpBackendService,
} from './git-http-backend.service';
import { Logger } from '@nestjs/common';
import type { GitHttpBackendRequest } from './git-http-backend.service';

const spawnMock = spawn as unknown as jest.Mock;

/** A fake `git http-backend` child: EventEmitter + stdout/stderr/stdin streams. */
function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // stdin is written/ended/piped to; capture the calls, swallow nothing.
  child.stdin = Object.assign(new EventEmitter(), {
    end: jest.fn(),
    write: jest.fn(),
  });
  // The watchdog kills the child on timeout; capture the signal.
  child.kill = jest.fn();
  return child;
}

/** A fake raw Node ServerResponse capturing status/headers/body/end. */
function fakeRes() {
  const res: any = {
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    _headers: {} as Record<string, string>,
    _written: [] as Buffer[],
    setHeader: jest.fn((name: string, value: string) => {
      res._headers[name] = value;
    }),
    write: jest.fn((chunk: Buffer) => {
      res._written.push(chunk);
      return true;
    }),
    end: jest.fn((chunk?: Buffer | string) => {
      if (chunk !== undefined) res._written.push(chunk as Buffer);
      res.writableEnded = true;
    }),
  };
  return res;
}

/** A fake raw Node IncomingMessage (GET => no body piped). */
function fakeReq() {
  const req = new EventEmitter() as any;
  req.pipe = jest.fn();
  return req;
}

const baseRequest: GitHttpBackendRequest = {
  spaceId: 'space-1',
  subpath: 'info/refs',
  method: 'GET',
  queryString: 'service=git-upload-pack',
  contentType: '',
  remoteUser: 'alice@example.com',
};

function buildService(backendTimeoutMs = 120000) {
  const env = {
    getGitSyncDataDir: jest.fn(() => '/vaults'),
    // The watchdog timeout for the spawned git http-backend. Tests inject a tiny
    // value (or use fake timers) to drive the timeout branch.
    getGitSyncBackendTimeoutMs: jest.fn(() => backendTimeoutMs),
  };
  return new GitHttpBackendService(env as any);
}

// `run()` now awaits the async `loadGitSync()` bridge before it spawns the
// child, so the spawn (and its stream-handler wiring) happens one microtask
// after `run()` is called. These tests drive the fake child synchronously, so
// flush the microtask queue first to let `run()` reach the spawn.
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('GitHttpBackendService.run', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('(a) responds 500 when the child errors before any headers were written', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService();
    const res = fakeRes();

    const p = service.run(baseRequest, fakeReq(), res);
    await flush();
    // Emit a child 'error' before any stdout -> 500, headers not already sent.
    child.emit('error', new Error('ENOENT spawn git'));
    await p;

    expect(res.statusCode).toBe(500);
    expect(res._headers['Content-Type']).toBe('text/plain');
    expect(res.end).toHaveBeenCalledWith('Internal server error');
  });

  it('(a) responds 500 when the child closes before a complete CGI header block', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService();
    const res = fakeRes();

    const p = service.run(baseRequest, fakeReq(), res);
    await flush();
    // stderr diagnostics, then a close with no valid CGI output -> 500.
    child.stderr.emit('data', Buffer.from('fatal: boom'));
    child.emit('close', 128);
    await p;

    expect(res.statusCode).toBe(500);
    expect(res.end).toHaveBeenCalledWith('Internal server error');
  });

  it('(b) parses the CGI header block, sets status/headers, writes the body', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService();
    const res = fakeRes();

    const p = service.run(baseRequest, fakeReq(), res);
    await flush();
    // A full CGI response: status line + header + blank line + body.
    child.stdout.emit(
      'data',
      Buffer.from(
        'Status: 200 OK\r\nContent-Type: application/x-git-upload-pack-advertisement\r\n\r\nPACKBODY',
        'utf8',
      ),
    );
    child.emit('close', 0);
    await p;

    expect(res.statusCode).toBe(200);
    expect(res._headers['Content-Type']).toBe(
      'application/x-git-upload-pack-advertisement',
    );
    expect(Buffer.concat(res._written.map((c) => Buffer.from(c))).toString()).toContain(
      'PACKBODY',
    );
    expect(res.writableEnded).toBe(true);
  });

  it('(c) swallows a stdout stream error (EPIPE) without throwing or 500ing', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService();
    const res = fakeRes();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');

    const p = service.run(baseRequest, fakeReq(), res);
    await flush();
    // The stdout 'error' handler must absorb this — no unhandled throw, no 500.
    expect(() => child.stdout.emit('error', new Error('EPIPE'))).not.toThrow();
    expect(() => child.stderr.emit('error', new Error('EPIPE'))).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    expect(res.statusCode).not.toBe(500);

    // Let run() settle so the promise does not dangle.
    child.emit('close', 0);
    await p;
  });

  it('(d) timeout: a child that never closes is killed and a 500 is sent', async () => {
    // The child never emits stdout/close (a stalled git-receive-pack). With a
    // tiny injected watchdog timeout the run() promise must still resolve: the
    // child is killed and a clean 500 is sent (no headers were sent yet).
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService(5); // 5ms watchdog
    const res = fakeRes();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');

    // run() resolves only via the watchdog firing (no close/error emitted).
    await service.run(baseRequest, fakeReq(), res);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(warnSpy).toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.end).toHaveBeenCalledWith('Internal server error');
  });

  it('(d) timeout watchdog is cleared on a normal close (no kill, no 500)', async () => {
    // A normal request that completes well within the watchdog window must NOT be
    // killed and must NOT trip the timeout 500 — the timer is cleared on close.
    jest.useFakeTimers();
    try {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const service = buildService(120000);
      const res = fakeRes();

      const p = service.run(baseRequest, fakeReq(), res);
      // loadGitSync resolves on a real microtask; advance it under fake timers.
      await Promise.resolve();
      await Promise.resolve();

      child.stdout.emit(
        'data',
        Buffer.from('Status: 200 OK\r\nContent-Type: text/plain\r\n\r\nOK', 'utf8'),
      );
      child.emit('close', 0);
      await p;

      // The watchdog never fired even if we advance past its window.
      jest.advanceTimersByTime(200000);
      expect(child.kill).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
    } finally {
      jest.useRealTimers();
    }
  });

  it('spawn throwing synchronously -> 500 (spawn-failed)', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn EACCES');
    });
    const service = buildService();
    const res = fakeRes();

    await service.run(baseRequest, fakeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(res.end).toHaveBeenCalledWith('Internal server error');
  });

  it('(abort) an ALREADY-aborted signal -> no spawn, 500 lock-lost', async () => {
    // The per-space lock was already lost before run() reached the spawn: we must
    // NOT start writing the working tree after a possible lock takeover.
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService();
    const res = fakeRes();

    const controller = new AbortController();
    controller.abort();
    await service.run(baseRequest, fakeReq(), res, controller.signal);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.end).toHaveBeenCalledWith('Internal server error');
  });

  it('(abort) a live signal aborted mid-request -> child SIGTERM + response closed', async () => {
    // The lock lapses mid-push: the abort fires, the child is killed (SIGTERM,
    // then SIGKILL on escalation), and the response is finished.
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService();
    const res = fakeRes();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');

    const controller = new AbortController();
    const p = service.run(baseRequest, fakeReq(), res, controller.signal);
    await flush(); // let run() reach the spawn + wire the abort listener
    controller.abort();
    await p;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(warnSpy).toHaveBeenCalled();
    // No headers were sent before the abort -> a clean 500 is sent and ended.
    expect(res.statusCode).toBe(500);
    expect(res.writableEnded).toBe(true);
  });
});

describe('buildGitBackendCgiEnv', () => {
  const base = {
    spaceId: 'space-1',
    subpath: 'info/refs',
    method: 'GET',
    queryString: 'service=git-upload-pack',
    contentType: '',
    remoteUser: 'alice@example.com',
  };

  it('points PATH_INFO at the NON-bare repo dir (no .git suffix)', () => {
    // Regression guard: the vault lives at <root>/<spaceId> (a working repo), so
    // PATH_INFO must be /<spaceId>/<subpath>. A `.git` suffix made git
    // http-backend resolve <root>/<spaceId>.git and 404 every fetch/push.
    const env = buildGitBackendCgiEnv(base, '/vaults');
    expect(env.PATH_INFO).toBe('/space-1/info/refs');
    expect(env.PATH_INFO).not.toContain('.git');
    expect(env.GIT_PROJECT_ROOT).toBe('/vaults');
  });

  it('forwards method/query/content-type/remote-user and exports all repos', () => {
    const env = buildGitBackendCgiEnv(
      { ...base, method: 'POST', subpath: 'git-receive-pack', contentType: 'application/x-git-receive-pack-request', queryString: '' },
      '/vaults',
    );
    expect(env.REQUEST_METHOD).toBe('POST');
    expect(env.PATH_INFO).toBe('/space-1/git-receive-pack');
    expect(env.CONTENT_TYPE).toBe('application/x-git-receive-pack-request');
    expect(env.REMOTE_USER).toBe('alice@example.com');
    expect(env.GIT_HTTP_EXPORT_ALL).toBe('1');
  });

  it('sets GIT_PROTOCOL only when the client sent the header', () => {
    expect(buildGitBackendCgiEnv(base, '/vaults').GIT_PROTOCOL).toBeUndefined();
    expect(
      buildGitBackendCgiEnv({ ...base, gitProtocol: 'version=2' }, '/vaults')
        .GIT_PROTOCOL,
    ).toBe('version=2');
  });
});

describe('parseCgiResponse', () => {
  it('defaults to status 200 with no Status header', () => {
    const r = parseCgiResponse('Content-Type: application/x-git-upload-pack-result');
    expect(r.statusCode).toBe(200);
    expect(r.headers).toEqual([
      ['Content-Type', 'application/x-git-upload-pack-result'],
    ]);
  });

  it('honors a Status header and does not forward it', () => {
    const r = parseCgiResponse('Status: 404 Not Found\nContent-Type: text/plain');
    expect(r.statusCode).toBe(404);
    expect(r.headers).toEqual([['Content-Type', 'text/plain']]);
  });

  it('parses multiple headers and trims whitespace', () => {
    const r = parseCgiResponse(
      'Status: 403 Forbidden\r\nContent-Type:  text/plain \r\nX-Foo:  bar ',
    );
    expect(r.statusCode).toBe(403);
    expect(r.headers).toEqual([
      ['Content-Type', 'text/plain'],
      ['X-Foo', 'bar'],
    ]);
  });

  it('ignores malformed (colon-less) lines defensively', () => {
    const r = parseCgiResponse('Content-Type: text/plain\ngarbage-line\nX-A: b');
    expect(r.statusCode).toBe(200);
    expect(r.headers).toEqual([
      ['Content-Type', 'text/plain'],
      ['X-A', 'b'],
    ]);
  });

  it('ignores an out-of-range Status code and keeps the default', () => {
    const r = parseCgiResponse('Status: not-a-number\nContent-Type: text/plain');
    expect(r.statusCode).toBe(200);
  });

  it('treats the Status header case-insensitively', () => {
    const r = parseCgiResponse('status: 500 Boom');
    expect(r.statusCode).toBe(500);
    expect(r.headers).toEqual([]);
  });
});

describe('splitCgiBuffer', () => {
  it('splits on a CRLF blank line and keeps the body as bytes', () => {
    const buf = Buffer.concat([
      Buffer.from('Status: 200 OK\r\nContent-Type: text/plain\r\n\r\n', 'utf8'),
      Buffer.from([0x00, 0x01, 0x02, 0xff]),
    ]);
    const split = splitCgiBuffer(buf);
    expect(split).not.toBeNull();
    expect(split!.headerText).toBe('Status: 200 OK\r\nContent-Type: text/plain');
    expect(Array.from(split!.body)).toEqual([0x00, 0x01, 0x02, 0xff]);
  });

  it('splits on a bare LF blank line', () => {
    const buf = Buffer.from('Content-Type: text/plain\n\nhello', 'utf8');
    const split = splitCgiBuffer(buf);
    expect(split).not.toBeNull();
    expect(split!.headerText).toBe('Content-Type: text/plain');
    expect(split!.body.toString('utf8')).toBe('hello');
  });

  it('returns an empty body when nothing follows the separator', () => {
    const buf = Buffer.from('Content-Type: text/plain\r\n\r\n', 'utf8');
    const split = splitCgiBuffer(buf);
    expect(split).not.toBeNull();
    expect(split!.body.length).toBe(0);
  });

  it('returns null when there is no blank-line separator yet', () => {
    const buf = Buffer.from('Content-Type: text/plain\r\nincomplete', 'utf8');
    expect(splitCgiBuffer(buf)).toBeNull();
  });
});
