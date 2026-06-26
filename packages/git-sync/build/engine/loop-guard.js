/**
 * Loop-guard primitives (SPEC §10). The sync engine must never re-pull its OWN
 * write as if it were a remote edit: after a push, the next poll will see the
 * page it just wrote with a fresh `updatedAt`. To suppress that, we key on two
 * signals — the body HASH of what we pushed (this module) and the `updatedAt`
 * returned by the write — recorded per page at push time.
 *
 * This module owns the PURE, deterministic body-hash. The CONSUMPTION on the
 * pull side (comparing an incoming page's body hash against the last pushed hash
 * to decide "this is our own write, ignore it") is a future increment — here we
 * only PRODUCE the hash and the per-page push record (see `src/push.ts`).
 */
import { createHash } from "node:crypto";
/**
 * Stable hash of a page's markdown BODY (SPEC §10 "хэш тела"). Deterministic:
 * the same input string always yields the same digest, a different input a
 * different one. Used to recognize our own write later (loop suppression).
 *
 * We hash the body STRING as-is (UTF-8) with SHA-256 and return lowercase hex.
 * SPEC §10 keys on the body hash rather than file bytes; callers decide WHAT
 * counts as "the body" (here it is the exact string passed in — typically the
 * self-contained markdown that was pushed). No normalization is applied: the
 * caller is responsible for passing a canonical/stable representation if it
 * wants hash equality across cosmetic-only differences.
 */
export function bodyHash(markdownBody) {
    return createHash("sha256").update(markdownBody, "utf8").digest("hex");
}
