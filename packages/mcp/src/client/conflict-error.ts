/**
 * #647 §G/§H — thrown by the guarded page-content writes (`updatePageJson` /
 * `updatePageMarkdown`) when the server-side write-CAS rejects the write because
 * the page changed since the agent read it (HTTP 409 from `/pages/update`).
 *
 * `currentHash` is the live content hash the server computed at write time: the
 * agent should re-read the page (getPageJson / getPage, which returns a fresh
 * `baseHash`) and retry the write against that new base — a BOUNDED number of
 * times (there is no `force`; a page a human is continuously typing into will
 * keep rejecting, at which point the agent must back off and report rather than
 * loop). A concurrent edit is preserved: the rejected write never landed.
 */
export class ConflictError extends Error {
  readonly currentHash?: string;

  constructor(message: string, currentHash?: string) {
    super(message);
    this.name = "ConflictError";
    this.currentHash = currentHash;
    // Restore the prototype chain across the TS `extends Error` down-level emit
    // so `instanceof ConflictError` holds for callers that branch on it.
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}
