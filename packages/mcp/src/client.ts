// DocmostClient — thin facade assembled from domain mixins (issue #450).
//
// The 5206-line god-object was split into cohesive domain modules under
// `client/`, each a mixin layered on the shared `DocmostClientContext` base
// (which owns the axios client, auth, apiUrl, the resolvePageId cache and the
// core HTTP/write seams). The mixins compose into ONE prototype chain, so:
//   - every public method name/signature is UNCHANGED (the external contract —
//     `DocmostClientLike` = `Pick<DocmostClient, ...>`, the in-app adapter, and
//     both transports — resolves exactly as before);
//   - `this.<method>` dispatches virtually across modules, so a test subclass
//     that overrides a seam (`mutatePage`, `resolvePageId`, `getPageRaw`,
//     `getCollabTokenWithReauth`, `uploadAttachmentBuffer`, `fetchAttachmentText`)
//     is still seen by every caller — the load-bearing #449/#425 patterns
//     (single held page-lock, self-resolving write seams, the no-await critical
//     window in collab-session) are preserved byte-for-byte in their modules.
//
// This file only wires the chain and re-exports the package's public surface.
import { DocmostClientContext } from "./client/context.js";
import { ReadMixin, type IReadMixin } from "./client/read.js";
import { PagesMixin, type IPagesMixin } from "./client/pages.js";
import { NodesWriteMixin, type INodesWriteMixin } from "./client/nodes-write.js";
import { TablesMixin, type ITablesMixin } from "./client/tables.js";
import { DocValidateMixin } from "./client/doc-validate.js";
import { MediaMixin, type IMediaMixin } from "./client/media.js";
import { StashMixin, type IStashMixin } from "./client/stash.js";
import { DrawioMixin, type IDrawioMixin } from "./client/drawio.js";
import { CommentsMixin, type ICommentsMixin } from "./client/comments.js";
import { TransformsMixin, type ITransformsMixin } from "./client/transforms.js";

// Re-export the package's public types + helpers from their new homes so every
// existing importer (index.ts, http.ts, stdio.ts, the in-app host) keeps working
// with ZERO changes.
export type { DocmostMcpConfig, SandboxPut } from "./client/context.js";
export {
  formatDocmostAxiosError,
  assertFullUuid,
  formatSpaceNotAccessible,
} from "./client/errors.js";

// Branded canonical page-identity type (#435): the internal page UUID is a
// distinct nominal type so an unresolved raw/slug string can't be swapped into
// the seams that require the canonical id (see lib/page-id.ts). Re-exported on
// the package surface for hosts that type against the resolved id.
export type { PageId } from "./lib/page-id.js";

// The full public + shared instance surface of the assembled client. Built by
// INTERSECTING each domain mixin's public interface (each DERIVED from its class
// and enforced by that class's `implements` clause — issue #446, no hand-mirror)
// with the shared context. Named explicitly so the emitted `.d.ts` refers to
// this type rather than the anonymous mixin-composed class (which carries the
// base's `protected` shared state and would otherwise trip TS4094). DocValidate
// exposes no PUBLIC methods (all its helpers are protected), so it contributes
// nothing to the public surface and needs no interface here.
//
// Signature fidelity: every method's NAME and PARAMETER types are preserved
// exactly (the contract surface both hosts type-check against — `DocmostClientLike
// = Pick<DocmostClient, ...>`, the in-app adapter). Explicit source return types
// (e.g. `stashPage`, `exportPageMarkdown`, the drawio tools) are carried through
// verbatim; methods that relied on inference in the monolith surface as `any`
// return here — a deliberate, contract-safe trade-off, since the execute
// wrappers and the adapter consume the arguments, not the awaited return shape.
type DocmostClientInstance = DocmostClientContext &
  IReadMixin &
  IPagesMixin &
  INodesWriteMixin &
  ITablesMixin &
  IMediaMixin &
  IStashMixin &
  IDrawioMixin &
  ICommentsMixin &
  ITransformsMixin;

// Compose the domain mixins over the shared context. Order is irrelevant to
// behaviour (cross-module calls go through `this`, resolved at runtime on the
// assembled instance); it only affects the prototype-chain nesting. The
// explicit constructor-type annotation keeps the exported `.d.ts` referring to
// the NAMED `DocmostClientInstance` rather than the anonymous composed class.
const DocmostClientBase: new (...args: any[]) => DocmostClientInstance =
  TransformsMixin(
    CommentsMixin(
      DrawioMixin(
        StashMixin(
          MediaMixin(
            DocValidateMixin(
              TablesMixin(
                NodesWriteMixin(PagesMixin(ReadMixin(DocmostClientContext))),
              ),
            ),
          ),
        ),
      ),
    ),
  ) as unknown as new (...args: any[]) => DocmostClientInstance;

/**
 * The Docmost API client used by both the standalone MCP server and the in-app
 * AI-SDK host. A thin, concrete assembly of the domain mixins above; carries no
 * logic of its own. See `client/` for the per-domain implementations. Its public
 * method surface is UNCHANGED from the original monolith, so the external
 * contract (`DocmostClientLike = Pick<DocmostClient, ...>`, the in-app adapter,
 * both transports' execute-wrappers) resolves identically.
 */
export class DocmostClient extends DocmostClientBase {}
