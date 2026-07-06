import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadGitSync } from '../git-sync.loader';
import { EnvironmentService } from '../../environment/environment.service';

/** The parsed first part of a CGI response: the HTTP status + header pairs. */
export interface ParsedCgiResponse {
  statusCode: number;
  /** Lower-cased? No — keep header names verbatim as git http-backend emits. */
  headers: Array<[string, string]>;
}

/**
 * Parse the CGI header block emitted by `git http-backend` into an HTTP status
 * and a list of header pairs. The input is ONLY the header text (everything up
 * to, but not including, the blank-line separator) — the binary body is split
 * off by the caller on the raw Buffer (never stringified).
 *
 * CGI semantics (RFC 3875 §6): a `Status: <code> <reason>` header sets the HTTP
 * status (default 200 when absent). Every other header is forwarded verbatim.
 * Header lines are `Name: value`; a line without a ':' is ignored defensively.
 *
 * Pure + framework-free so it is unit-testable in isolation.
 */
export function parseCgiResponse(headerBlock: string): ParsedCgiResponse {
  let statusCode = 200;
  const headers: Array<[string, string]> = [];

  // Header lines may be separated by CRLF or LF; split on either.
  const lines = headerBlock.split(/\r?\n/);
  for (const line of lines) {
    if (line.length === 0) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue; // not a header line — ignore defensively
    const name = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (name.toLowerCase() === 'status') {
      // `Status: 404 Not Found` — the leading integer is the HTTP status code.
      const code = parseInt(value, 10);
      if (Number.isFinite(code) && code >= 100 && code <= 599) {
        statusCode = code;
      }
      continue; // never forward the CGI Status header itself
    }
    headers.push([name, value]);
  }

  return { statusCode, headers };
}

/**
 * Split a raw CGI response buffer at the first blank-line boundary
 * (`\r\n\r\n` or `\n\n`). Returns the header text and the remaining body bytes.
 * Returns null when no blank-line separator is present (a malformed response).
 *
 * Pure (operates on Buffers, never stringifies the body) so it is testable.
 */
export function splitCgiBuffer(
  buf: Buffer,
): { headerText: string; body: Buffer } | null {
  // Prefer the CRLF separator; fall back to bare LF.
  let idx = buf.indexOf('\r\n\r\n');
  let sepLen = 4;
  if (idx === -1) {
    idx = buf.indexOf('\n\n');
    sepLen = 2;
  }
  if (idx === -1) return null;
  const headerText = buf.subarray(0, idx).toString('utf8');
  const body = buf.subarray(idx + sepLen);
  return { headerText, body };
}

/** A parsed git smart-HTTP request, resolved by the controller/handler. */
export interface GitHttpBackendRequest {
  /** The space id (the on-disk vault dir name == GIT_PROJECT_ROOT child). */
  spaceId: string;
  /** The subpath after `<spaceId>.git/`, e.g. `info/refs` or `git-receive-pack`. */
  subpath: string;
  /** REQUEST_METHOD — `GET` or `POST`. */
  method: string;
  /** Raw query string WITHOUT the leading '?', e.g. `service=git-receive-pack`. */
  queryString: string;
  /** Content-Type header value (may be empty for GET). */
  contentType: string;
  /** The Git-Protocol request header value, or undefined when absent. */
  gitProtocol?: string;
  /** Content-Encoding request header (e.g. `gzip`), or undefined when absent.
   * git gzips RPC bodies >1KiB; http-backend only inflates when HTTP_CONTENT_ENCODING
   * is present, so it MUST be forwarded or a non-trivial `git pull` fails with
   * `fatal: expected 'packfile'` (review #4). */
  contentEncoding?: string;
  /** Authenticated user email — used as REMOTE_USER (reflog identity). */
  remoteUser: string;
}

/**
 * Bridges an HTTP git smart-protocol request to `git http-backend` (the CGI that
 * implements the entire smart-HTTP protocol: info/refs, upload-pack,
 * receive-pack, protocol v2, dumb fallback). We do NOT reimplement pkt-line.
 *
 * The Fastify reply is hijacked by the caller; this service streams the request
 * body to the child's stdin and writes the child's CGI response (status +
 * headers parsed from the leading header block, then the raw binary body) to the
 * Node response. Errors before any output produce a 500. Credentials are never
 * logged.
 */
/**
 * Build the `git http-backend` CGI environment overlay for one request (the
 * variables layered on top of `vaultGitEnv`'s cwd-isolated base). Pure so the
 * PATH_INFO / REMOTE_USER / conditional GIT_PROTOCOL wiring is unit-testable
 * without spawning git.
 *
 * PATH_INFO is the repo-relative CGI path. The vault is a NON-BARE working repo
 * on disk at `<dataDir>/<spaceId>` (the engine needs a working tree), so the
 * repo directory git http-backend must resolve is `<spaceId>` — NOT
 * `<spaceId>.git`. The URL carries the conventional `.git` suffix (stripped by
 * parseGitPath into `spaceId`); re-appending it here pointed the CGI at a
 * non-existent `<dataDir>/<spaceId>.git` and every fetch/push 404'd.
 */
export function buildGitBackendCgiEnv(
  parsed: GitHttpBackendRequest,
  projectRoot: string,
): Record<string, string> {
  const cgiEnv: Record<string, string> = {
    GIT_PROJECT_ROOT: projectRoot,
    GIT_HTTP_EXPORT_ALL: '1', // authz is done by us; no git-daemon-export-ok file
    PATH_INFO: `/${parsed.spaceId}/${parsed.subpath}`,
    REQUEST_METHOD: parsed.method,
    QUERY_STRING: parsed.queryString,
    CONTENT_TYPE: parsed.contentType,
    REMOTE_USER: parsed.remoteUser,
  };
  // GIT_PROTOCOL is only set when the client sent the Git-Protocol header.
  if (parsed.gitProtocol) {
    cgiEnv.GIT_PROTOCOL = parsed.gitProtocol;
  }
  // HTTP_CONTENT_ENCODING must be forwarded so git http-backend inflates a
  // gzip'd RPC body (git compresses receive-pack/upload-pack bodies >1KiB).
  // Without it a non-trivial `git pull` negotiation fails deterministically with
  // `fatal: expected 'packfile'` (review #4). The body is piped to stdin as-is
  // (no upstream decompression), so the CGI must do the inflate.
  if (parsed.contentEncoding) {
    cgiEnv.HTTP_CONTENT_ENCODING = parsed.contentEncoding;
  }
  return cgiEnv;
}

@Injectable()
export class GitHttpBackendService {
  private readonly logger = new Logger(GitHttpBackendService.name);

  constructor(private readonly environmentService: EnvironmentService) {}

  /**
   * Spawn `git http-backend` for one request and bridge it to the raw Node
   * request/response. Resolves when the response has been fully written (the
   * child exited and its output was flushed), or after a 500 was sent on an
   * early failure. Never rejects — push ingestion relies on this resolving so
   * the lock-held cycle body can run afterwards.
   *
   * `signal` (optional) is the git-sync per-space lock's lost-lock abort signal.
   * A receive-pack writes `main`'s working tree, so if the lock lapses mid-push
   * (heartbeat CAS miss / Redis outage) the signal fires and we kill the child —
   * preventing it from continuing to write the working tree while another replica
   * may have taken over the lock and started a cycle (warning #3).
   */
  async run(
    parsed: GitHttpBackendRequest,
    rawReq: IncomingMessage,
    rawRes: ServerResponse,
    signal?: AbortSignal,
  ): Promise<void> {
    const { vaultGitEnv } = await loadGitSync();
    const projectRoot = this.environmentService.getGitSyncDataDir();
    // Build the CGI env from the engine's cwd-isolated base (strips GIT_DIR /
    // GIT_WORK_TREE), then layer the http-backend CGI variables. PATH is
    // preserved (vaultGitEnv already copies process.env, so PATH carries
    // through).
    const env = vaultGitEnv(buildGitBackendCgiEnv(parsed, projectRoot));

    return new Promise<void>((resolve) => {
      let settled = false;
      // Set once the child exists so the abort handler can target it.
      let onAbort: (() => void) | null = null;
      // The watchdog timer; cleared centrally in done() so EVERY settle path
      // (close, error, timeout, abort) tears it down exactly once.
      let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (settled) return;
        settled = true;
        if (watchdogTimer) clearTimeout(watchdogTimer);
        // Detach the abort listener so a later lock loss does not fire into a
        // request that already finished.
        if (onAbort) {
          signal?.removeEventListener('abort', onAbort);
          onAbort = null;
        }
        resolve();
      };

      // Reject early if the lock was already lost before we even spawned: do not
      // start writing the working tree after a possible lock takeover.
      if (signal?.aborted) {
        if (!rawRes.headersSent) this.send500(rawRes, 'lock-lost');
        else
          try {
            rawRes.end();
          } catch {
            /* ignore */
          }
        return done();
      }

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('git', ['http-backend'], { env });
      } catch (err) {
        this.send500(rawRes, 'spawn-failed', err);
        return done();
      }

      // Lost-lock abort: the per-space lock lapsed mid-request. Kill the child so
      // a receive-pack stops writing `main`'s working tree before another replica
      // (which may now hold the lock) starts a cycle. Same kill+finish path the
      // watchdog uses (extracted into terminateChild).
      onAbort = () => {
        this.terminateChild(
          child,
          rawRes,
          headerParsed,
          'lock-lost',
          'git http-backend aborted (git-sync lock lost mid-request); killing child',
          done,
        );
      };
      signal?.addEventListener('abort', onAbort);

      // Watchdog: a client that opens git-receive-pack and stalls keeps the
      // child alive forever, so run() never resolves and (because this runs
      // inside withSpaceLock) the per-space lock is held + heartbeat-refreshed
      // indefinitely. Bound the request: on expiry kill the child, send a clean
      // 500 if nothing was sent yet, and settle the promise. `.unref()` so the
      // timer never keeps the event loop alive; ALWAYS cleared in done().
      watchdogTimer = setTimeout(() => {
        this.terminateChild(
          child,
          rawRes,
          headerParsed,
          'timeout',
          `git http-backend timed out after ` +
            `${this.environmentService.getGitSyncBackendTimeoutMs()}ms; killing child`,
          done,
        );
      }, this.environmentService.getGitSyncBackendTimeoutMs());
      watchdogTimer.unref?.();

      // Accumulate stdout until we have the full CGI header block, then write the
      // parsed status/headers and start streaming the remaining body bytes.
      let headerParsed = false;
      let pending: Buffer = Buffer.alloc(0);

      const flushHeadersAndBody = (chunk: Buffer): void => {
        pending = Buffer.concat([pending, chunk]);
        const split = splitCgiBuffer(pending);
        if (!split) return; // header block not complete yet
        headerParsed = true;
        const { statusCode, headers } = parseCgiResponse(split.headerText);
        rawRes.statusCode = statusCode;
        for (const [name, value] of headers) {
          rawRes.setHeader(name, value);
        }
        if (split.body.length > 0) rawRes.write(split.body);
        pending = Buffer.alloc(0);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        if (headerParsed) {
          rawRes.write(chunk);
        } else {
          flushHeadersAndBody(chunk);
        }
      });
      // A stream 'error' (e.g. EPIPE when the client aborts mid-response) is an
      // EventEmitter 'error' with no listener -> Node rethrows it as an uncaught
      // exception and crashes the process. Swallow + log it (never echo to the
      // client); child.on('close')/'error' below drives the actual cleanup.
      child.stdout?.on('error', (err) => {
        this.logger.warn(`git http-backend stdout stream error: ${err.message}`);
      });

      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        // Capture for diagnostics; never echo to the client. http-backend writes
        // CGI errors here. We do NOT log the request body or any credentials.
        if (stderr.length < 8192) stderr += chunk.toString('utf8');
      });
      child.stderr?.on('error', (err) => {
        this.logger.warn(`git http-backend stderr stream error: ${err.message}`);
      });

      child.on('error', (err) => {
        // The watchdog timer is cleared centrally in done().
        if (!headerParsed && !rawRes.headersSent) {
          this.send500(rawRes, 'child-error', err);
        } else {
          // Output already started — we can only terminate the stream.
          try {
            rawRes.end();
          } catch {
            /* ignore */
          }
        }
        done();
      });

      child.on('close', (code) => {
        // The watchdog timer is cleared centrally in done().
        if (!headerParsed && !rawRes.headersSent) {
          // The child exited before emitting a complete CGI header block.
          this.logger.error(
            `git http-backend produced no valid response (exit ${code}) for ` +
              `space; stderr: ${stderr.trim().slice(0, 500)}`,
          );
          this.send500(rawRes, 'no-output');
        } else {
          try {
            rawRes.end();
          } catch {
            /* ignore */
          }
        }
        done();
      });

      // Pipe the request body to the child's stdin. For GET there is no body, so
      // end stdin immediately. We pipe `rawReq` (the raw Node stream) directly so
      // large pushes are streamed, not buffered.
      if (parsed.method === 'POST') {
        rawReq.pipe(child.stdin!);
        rawReq.on('error', () => {
          try {
            child.stdin?.end();
          } catch {
            /* ignore */
          }
        });
      } else {
        child.stdin?.end();
      }
      // Swallow EPIPE etc. on the child's stdin so a client disconnect does not
      // crash the process.
      child.stdin?.on('error', () => {
        /* ignore broken-pipe on stdin */
      });
    });
  }

  /**
   * Kill the child (SIGTERM, then SIGKILL after a grace period if it ignores the
   * term) and finish the HTTP response cleanly, then settle. Shared by the two
   * forced-termination paths — the watchdog timeout and the lost-lock abort —
   * which differ ONLY by the log line and the send500 `reason`. If no response
   * has started a clean 500 is sent; otherwise the in-flight stream is just
   * ended. Never throws (a thrown kill/end would crash the request).
   */
  private terminateChild(
    child: ReturnType<typeof spawn>,
    rawRes: ServerResponse,
    responseStarted: boolean,
    send500Reason: string,
    logMessage: string,
    done: () => void,
  ): void {
    this.logger.warn(logMessage);
    try {
      child.kill('SIGTERM');
      // Escalate to SIGKILL shortly after in case SIGTERM is ignored.
      const sigkill = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 2000);
      sigkill.unref?.();
    } catch {
      /* ignore */
    }
    if (!responseStarted && !rawRes.headersSent) {
      this.send500(rawRes, send500Reason);
    } else {
      try {
        rawRes.end();
      } catch {
        /* ignore */
      }
    }
    done();
  }

  /** Send a clean 500 without leaking credentials or the request body. */
  private send500(rawRes: ServerResponse, reason: string, err?: unknown): void {
    const message = err instanceof Error ? err.message : undefined;
    this.logger.error(
      `git http-backend failed (${reason})${message ? `: ${message}` : ''}`,
    );
    try {
      if (!rawRes.headersSent) {
        rawRes.statusCode = 500;
        rawRes.setHeader('Content-Type', 'text/plain');
      }
      rawRes.end('Internal server error');
    } catch {
      /* ignore */
    }
  }
}
