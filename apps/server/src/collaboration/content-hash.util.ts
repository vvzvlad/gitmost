import { createHash } from 'node:crypto';

/**
 * #647 §A / R3 / R7 — the ONE place a page-content hash is computed in the whole
 * project. Both the server-side CAS base hash (readLiveIfLoaded / replaceIfMatch)
 * and the `/pages/info?includeContentHash` read path go through here, so a read
 * and a later write can never disagree because their normalization drifted.
 *
 * Policy (R7): sha256(hex) over a CANONICAL serialization of the ProseMirror JSON
 * — object keys recursively sorted, no insignificant whitespace. The input MUST
 * be the output of `TiptapTransformer.fromYdoc(doc, 'default')` for the doc whose
 * identity we are hashing (never the raw `page.content` — see #647 B1: the
 * transformer materializes attrs like `indent:0`, so `fromYdoc(toYdoc(x)) !== x`,
 * and hashing raw content would produce a permanent false 409).
 *
 * The hash is OPAQUE to clients: the MCP client never recomputes it, it only
 * echoes the string back, which is what keeps the "read/write normalization
 * diverged" class of bug impossible.
 */
export function pageContentHash(pmJson: unknown): string {
  return createHash('sha256').update(canonicalStringify(pmJson)).digest('hex');
}

/**
 * Deterministic, whitespace-free JSON serialization with recursively sorted
 * object keys. `undefined` object properties are dropped (JSON.stringify parity);
 * arrays keep their order (order is meaningful in a PM doc); primitives and
 * `null` serialize as ordinary JSON.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    // Match JSON.stringify: a property whose value is `undefined` is omitted.
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${canonicalStringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}
