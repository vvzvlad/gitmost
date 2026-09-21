/**
 * Public entry point for the in-process SVG -> PNG rasterizer.
 *
 * `rasterizeSvgToPng` posts a job to a long-lived worker thread that owns the
 * resvg wasm instance, and enforces a per-job wall-clock timeout by terminating
 * that worker (a synchronous wasm render cannot be interrupted any other way).
 * A terminated / crashed worker is transparently recreated on the next call,
 * and every in-flight job bound to a dead worker is rejected so no promise is
 * ever left dangling.
 *
 * No browser, no child process, no external service — the worker thread is
 * in-process, satisfying the #423 hard constraint.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { RASTER_MAX_SVG_BYTES, resolveTimeoutMs } from './rasterize.constants';
import type {
  RasterJobMessage,
  RasterJobReply,
} from './rasterize.worker';

export interface RasterizeOptions {
  maxLongestSidePx?: number;
  background?: string;
}

export interface RasterizeResult {
  png: Buffer;
  width: number;
  height: number;
}

interface PendingJob {
  resolve: (result: RasterizeResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  owner: Worker;
}

let worker: Worker | null = null;
let jobSeq = 0;
const pending = new Map<number, PendingJob>();

/**
 * Locate the worker entry. At runtime the compiled `.js` sits next to this file
 * under dist. Under ts-jest there is only the `.ts` source, so we spawn it with
 * ts-node registered (transpile-only, using the server tsconfig).
 */
function workerEntry(): { file: string; options?: { execArgv: string[]; env: NodeJS.ProcessEnv } } {
  const compiled = path.join(__dirname, 'rasterize.worker.js');
  if (fs.existsSync(compiled)) {
    return { file: compiled };
  }
  const source = path.join(__dirname, 'rasterize.worker.ts');
  // src/integrations/ai/rasterize -> up 4 -> apps/server/tsconfig.json
  const tsconfig = path.resolve(__dirname, '..', '..', '..', '..', 'tsconfig.json');
  return {
    file: source,
    options: {
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      env: {
        ...process.env,
        TS_NODE_PROJECT: tsconfig,
        TS_NODE_TRANSPILE_ONLY: '1',
      },
    },
  };
}

function onMessage(from: Worker, reply: RasterJobReply): void {
  const job = pending.get(reply.jobId);
  // Ignore replies from a worker we have already abandoned (e.g. a late reply
  // that raced a timeout-driven terminate).
  if (!job || job.owner !== from) return;
  pending.delete(reply.jobId);
  clearTimeout(job.timer);
  if (reply.error) {
    job.reject(new Error(reply.error));
  } else {
    job.resolve({
      png: Buffer.from(reply.png!),
      width: reply.width!,
      height: reply.height!,
    });
  }
}

/**
 * Handle a worker going down (crash, error event, or exit) for reasons other
 * than our own timeout path: reject every job that belonged to it and, if it is
 * still the active worker, drop it so the next call spawns a fresh one.
 */
function onWorkerDown(dead: Worker, error: Error): void {
  if (worker === dead) worker = null;
  for (const [jobId, job] of pending) {
    if (job.owner === dead) {
      clearTimeout(job.timer);
      pending.delete(jobId);
      job.reject(error);
    }
  }
}

function spawnWorker(): Worker {
  const { file, options } = workerEntry();
  const w = new Worker(file, options);
  w.on('message', (reply: RasterJobReply) => onMessage(w, reply));
  w.on('error', (err) =>
    onWorkerDown(w, err instanceof Error ? err : new Error(String(err))),
  );
  w.on('exit', (code) => {
    if (code !== 0) {
      onWorkerDown(w, new Error(`rasterize worker exited (code ${code})`));
    }
  });
  // Do not let the worker keep the Node process alive by itself.
  w.unref();
  return w;
}

function ensureWorker(): Worker {
  if (!worker) worker = spawnWorker();
  return worker;
}

/**
 * Rasterize an SVG string to a PNG buffer. Pure in-process (wasm) in a worker
 * thread; no browser.
 */
export function rasterizeSvgToPng(
  svg: string,
  opts?: RasterizeOptions,
): Promise<RasterizeResult> {
  return new Promise<RasterizeResult>((resolve, reject) => {
    // Guard BEFORE touching resvg: reject oversized input outright.
    const byteLength = Buffer.byteLength(svg, 'utf8');
    if (byteLength > RASTER_MAX_SVG_BYTES) {
      reject(
        new Error(
          `SVG too large to rasterize: ${byteLength} bytes exceeds limit ${RASTER_MAX_SVG_BYTES}`,
        ),
      );
      return;
    }

    const w = ensureWorker();
    const jobId = ++jobSeq;
    const timeoutMs = resolveTimeoutMs();

    const timer = setTimeout(() => {
      const job = pending.get(jobId);
      if (!job) return;
      pending.delete(jobId);
      const dead = job.owner;
      // Drop the reference so the next call recreates the worker.
      if (worker === dead) worker = null;
      job.reject(new Error(`rasterize timed out after ${timeoutMs} ms`));
      // Terminate the (uninterruptible) worker; its 'exit' fires onWorkerDown,
      // which rejects any other jobs that were queued on the same dead worker.
      void dead.terminate();
    }, timeoutMs);

    pending.set(jobId, { resolve, reject, timer, owner: w });

    const message: RasterJobMessage = { jobId, svg, opts };
    try {
      w.postMessage(message);
    } catch (err) {
      pending.delete(jobId);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Terminate the worker and reject any in-flight jobs. Intended for graceful
 * shutdown and test teardown (so the worker thread does not keep Jest open).
 */
export async function shutdownRasterizer(): Promise<void> {
  const dead = worker;
  worker = null;
  for (const [jobId, job] of pending) {
    clearTimeout(job.timer);
    pending.delete(jobId);
    job.reject(new Error('rasterizer shut down'));
  }
  if (dead) await dead.terminate();
}
