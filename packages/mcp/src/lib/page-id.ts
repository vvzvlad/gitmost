/**
 * Branded canonical page-identity type for the MCP client (incident family #435).
 *
 * A Docmost page has TWO identities that are both plain strings: the internal
 * `page.id` (a canonical UUID the server generates as UUIDv7) and the public
 * `slugId` (a 10-char nanoid used in URLs). Because both are bare `string`s they
 * were passed around interchangeably and silently swapped — e.g. locking/keying a
 * collab doc by the slugId instead of the UUID (the #260 data-loss).
 *
 * `PageId` brands the CANONICAL id as a distinct nominal type so a raw/unresolved
 * string cannot flow into the seams that REQUIRE the canonical id (resolvePageId's
 * result, the per-page lock key, the collab write entrypoints) — those become a
 * COMPILE error, catching a swap at build time. It is still a `string` at runtime
 * (assignable INTO any `string` parameter unchanged), so branding flows outward
 * for free; the brand is minted at the single canonicalization seam
 * (`resolvePageId`, via `as PageId`).
 */
export type PageId = string & { readonly __brand: "PageId" };
