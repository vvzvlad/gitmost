// #487 F4 — the WRITE-side cancellation safe-point.
//
// Every content-mutating collab write (collaboration.mutatePageContent and the
// reentrant twin client.mutateLiveContentUnlocked used by replaceImage) checks
// the in-app tool abort signal at a PRE-COMMIT safe-point — after the collab
// session is acquired but immediately BEFORE the atomic read->write
// (session.mutate). So a Stop (or the per-call cap) that lands during the
// connect/lock window stops THIS write from landing: no new commit starts once
// aborted. paginate-abort-safepoint.test.mjs pins the READ half; this pins the
// integrity-critical WRITE half — remove the `throwIfAborted()` and the transform
// would run and the doc would be mutated past a Stop.
//
// There is no collab server in the unit env, so we swap the provider factory
// (__setCollabProviderFactory) for a fake that reports an immediate successful
// sync. That makes acquireCollabSession SUCCEED and hand back a live, ready
// session, so the ONLY thing standing between the call and session.mutate is the
// safe-point under test. The transform is instrumented to prove it never runs.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mutatePageContent } from "../../build/lib/collaboration.js";
import {
  __setCollabProviderFactory,
  destroyAllSessions,
} from "../../build/lib/collab-session.js";
import { DocmostClient } from "../../build/client.js";

const BASE_URL = "http://127.0.0.1:1/api";
// mutatePageContent locks via withPageLock, which demands a canonical page UUID
// (resolve-then-lock invariant, #260/#449); the unlocked twin does not.
const PAGE_UUID = "11111111-1111-4111-8111-111111111111";

// A fake HocuspocusProvider that immediately reports a successful initial sync so
// CollabSession.open() resolves to a ready session, and stays "synced" with zero
// unsynced changes so a reached session.mutate() would resolve at once. It speaks
// only the tiny CollabProviderLike surface the session depends on.
function syncedProviderFactory(config) {
  // Fire the initial-sync callback so open() settles as ready.
  config.onSynced();
  return {
    synced: true,
    unsyncedChanges: 0,
    destroy() {},
    on() {},
    off() {},
  };
}

// Disable the session cache so every acquire opens (and the failure path destroys)
// its own ephemeral session — no cross-test session reuse.
process.env.MCP_COLLAB_SESSION_IDLE_MS = "0";

afterEach(() => {
  __setCollabProviderFactory(null); // restore the real factory
  destroyAllSessions();
});

// --- collaboration.mutatePageContent (the page-locked write path) -------------

test("mutatePageContent rejects at the pre-commit safe-point BEFORE session.mutate when the signal is already aborted", async () => {
  __setCollabProviderFactory(syncedProviderFactory);
  let transformCalls = 0;
  const ac = new AbortController();
  ac.abort(new Error("user stop"));

  await assert.rejects(
    () =>
      mutatePageContent(
        PAGE_UUID,
        "collab-jwt",
        BASE_URL,
        (liveDoc) => {
          transformCalls++;
          return liveDoc;
        },
        ac.signal,
      ),
    /user stop/,
    "the aborted safe-point rejects with the signal's reason before committing",
  );
  assert.equal(
    transformCalls,
    0,
    "the transform (and therefore session.mutate) must NEVER run once aborted",
  );
});

test("mutatePageContent (control) DOES reach session.mutate and invoke the transform when the signal is live", async () => {
  __setCollabProviderFactory(syncedProviderFactory);
  let transformCalls = 0;
  const ac = new AbortController(); // never aborted

  const result = await mutatePageContent(
    PAGE_UUID,
    "collab-jwt",
    BASE_URL,
    (liveDoc) => {
      transformCalls++;
      return null; // null -> no-op write; still proves the transform was invoked
    },
    ac.signal,
  );
  assert.equal(
    transformCalls,
    1,
    "with a live signal the safe-point is a no-op and session.mutate runs the transform",
  );
  assert.ok(result && result.verify, "a MutationResult is returned");
});

// --- client.mutateLiveContentUnlocked (the reentrant twin, replaceImage) ------

test("mutateLiveContentUnlocked rejects at the pre-commit safe-point BEFORE session.mutate when the tool signal is already aborted", async () => {
  __setCollabProviderFactory(syncedProviderFactory);
  const client = new DocmostClient({
    apiUrl: BASE_URL,
    getToken: async () => "access",
    getCollabToken: async () => "collab-jwt",
  });
  let transformCalls = 0;
  const ac = new AbortController();
  ac.abort(new Error("cap fired"));
  client.setToolAbortSignal(ac.signal);

  await assert.rejects(
    () =>
      client.mutateLiveContentUnlocked("page-1", "collab-jwt", (liveDoc) => {
        transformCalls++;
        return liveDoc;
      }),
    /cap fired/,
    "the aborted safe-point rejects with the signal's reason before committing",
  );
  assert.equal(
    transformCalls,
    0,
    "the transform (and therefore session.mutate) must NEVER run once aborted",
  );
});

test("mutateLiveContentUnlocked (control) DOES reach session.mutate and invoke the transform when the tool signal is live", async () => {
  __setCollabProviderFactory(syncedProviderFactory);
  const client = new DocmostClient({
    apiUrl: BASE_URL,
    getToken: async () => "access",
    getCollabToken: async () => "collab-jwt",
  });
  let transformCalls = 0;
  client.setToolAbortSignal(new AbortController().signal); // live

  const result = await client.mutateLiveContentUnlocked(
    "page-1",
    "collab-jwt",
    (liveDoc) => {
      transformCalls++;
      return null;
    },
  );
  assert.equal(
    transformCalls,
    1,
    "with a live signal the safe-point is a no-op and session.mutate runs the transform",
  );
  assert.ok(result && result.verify, "a MutationResult is returned");
});
