// Worker-thread entry for the ELK layered layout (issue #486, commit 1).
//
// elkjs' layout() returns a Promise but runs the actual crossing-minimisation
// SYNCHRONOUSLY — it blocks whatever thread it runs on for the whole pass. On
// the in-app MCP host that thread used to be the main NestJS event loop, so a
// pathological graph at the node/edge cap could wedge ALL HTTP/SSE/loopback
// traffic while it churned. Running it HERE, on a dedicated worker thread, keeps
// the main loop free; the parent enforces the wall-clock timeout by calling
// `worker.terminate()` — the only way to interrupt synchronous JS — since the
// in-process `setTimeout` race the parent used before could never fire while the
// same thread was blocked inside elkjs.
import { parentPort, workerData } from "node:worker_threads";
import ELK from "elkjs/lib/elk.bundled.js";

interface WorkerInput {
  graph: unknown;
}

const { graph } = (workerData ?? {}) as WorkerInput;

// elkjs ships a CJS default export whose interop shape varies across module
// systems; resolve the real constructor at runtime (same as the parent did).
const Ctor: any = (ELK as any).default ?? ELK;
const elk = new Ctor();

elk
  .layout(graph as any)
  .then((laid: unknown) => {
    parentPort?.postMessage({ ok: true, laid });
  })
  .catch((err: unknown) => {
    parentPort?.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  });
