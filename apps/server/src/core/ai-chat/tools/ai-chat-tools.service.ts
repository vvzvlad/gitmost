import { Injectable, Logger } from '@nestjs/common';
import { tool, type Tool, type ToolCallOptions } from 'ai';
import { z } from 'zod';
import { User } from '@docmost/db/types/entity.types';
import { TokenService } from '../../auth/services/token.service';
import { AiService } from '../../../integrations/ai/ai.service';
import { EmbeddingGenerationService } from '../../../integrations/ai/embedding-generation.service';
import { AiEmbeddingNotConfiguredException } from '../../../integrations/ai/ai-embedding-not-configured.exception';
import { PageEmbeddingRepo } from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import {
  loadDocmostMcp,
  type DocmostClientLike,
  type SharedToolSpec,
  type CommentSignalTrackerLike,
} from './docmost-client.loader';
import {
  resolveCurrentPageResult,
  type SelectionContext,
} from './current-page.util';
import { parseNodeArg } from '@docmost/prosemirror-markdown';
import { modelFriendlyInput } from './model-friendly-input';
import { rasterizeSvgToPng } from '../../../integrations/ai/rasterize';
import { SandboxStore } from '../../../integrations/sandbox/sandbox.store';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  buildInAppDeferredCatalog,
  type ToolCatalogEntry,
} from './tool-tiers';

/**
 * Compile-time contract (issue #446): the in-app tool `execute` closures below
 * call the loopback `DocmostClient` POSITIONALLY (e.g.
 * `client.drawioGet(pageId, node, format ?? 'xml')`). Those closures receive an
 * AI-SDK-erased (`any`) input, so a positional call inside them is NOT checked
 * against the real signature — a parameter reorder/type-change in
 * `packages/mcp/src/client.ts` would otherwise reach production as a runtime
 * "wrong argument" tool failure with zero compile signal (the restored #294
 * debt). This never-called function reproduces every positional call with
 * correctly-typed placeholder arguments against the DERIVED `DocmostClientLike`
 * (a `Pick` of the real `DocmostClient`), so any such reorder/rename becomes a
 * SERVER COMPILE ERROR here. It emits nothing (types only) and is never invoked;
 * keep each call in lockstep with the matching `execute` body below.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function __assertClientCallContract(client: DocmostClientLike): void {
  // Placeholders standing in for the AI-SDK-erased execute inputs. Their types
  // are deliberately concrete so the positional calls are checked end-to-end.
  const s = '' as string;
  const n = 0 as number;
  const node: unknown = null;
  const edits: Array<{ find: string; replace: string; replaceAll?: boolean }> =
    [];
  const cells: string[] = [];
  const align = undefined as 'left' | 'center' | 'right' | undefined;

  // --- read ---
  void client.search(s, undefined, n);
  void client.getPage(s);
  void client.getPageRaw(s);
  void client.getWorkspace();
  void client.getSpaces();
  void client.listPages(s, n, true);
  void client.getTree(s, s, n);
  void client.getPageContext(s);
  void client.listSidebarPages(s, s);
  void client.getOutline(s);
  void client.getPageJson(s);
  void client.getNode(s, s, 'markdown');
  void client.searchInPage(s, s, {
    regex: true,
    caseSensitive: true,
    limit: n,
  });
  void client.getTable(s, s);
  void client.listComments(s, true);
  void client.getComment(s);
  void client.checkNewComments(s, s, s);
  void client.listShares();
  void client.listPageHistory(s, s);
  void client.getPageHistory(s);
  void client.diffPageVersions(s, s, s);
  void client.exportPageMarkdown(s);
  // --- write (page) ---
  void client.createPage(s, s, s, s);
  void client.updatePage(s, s, s, s);
  void client.renamePage(s, s);
  void client.movePage(s, s, s);
  void client.deletePage(s);
  void client.editPageText(s, edits);
  void client.patchNode(s, s, { markdown: s, node });
  void client.insertNode(
    s,
    { markdown: s, node },
    {
      position: 'append',
      anchorNodeId: s,
      anchorText: s,
    },
  );
  void client.deleteNode(s, s);
  void client.updatePageJson(s, node, s, s);
  void client.tableInsertRow(s, s, cells, n);
  void client.tableDeleteRow(s, s, n);
  void client.tableUpdateCell(s, s, n, n, s);
  void client.copyPageContent(s, s);
  void client.importPageMarkdown(s, s);
  void client.sharePage(s, true);
  void client.unsharePage(s);
  void client.restorePageVersion(s);
  void client.savePageVersion(s);
  void client.transformPage(s, s, { dryRun: true });
  void client.stashPage(s);
  // --- write (image / footnote), in-app since #410 ---
  void client.insertFootnote(s, s, s);
  void client.insertImage(s, s, {
    align,
    alt: s,
    replaceText: s,
    afterText: s,
  });
  void client.replaceImage(s, s, s, { align, alt: s });
  // --- read (attachment bytes), in-app since #588 (viewImage vision tool) ---
  void client.fetchAttachmentBytes(s);
  // --- draw.io diagrams (#423 stage 1, #424 stage 2) ---
  // The 5th `layout` arg (#424) is exercised so this parity assertion fails if the
  // client signature drops it — it must reach the client from the shared execute.
  void client.drawioGet(s, s, 'xml');
  void client.drawioCreate(s, { position: 'append', anchorNodeId: s }, s, s, 'elk');
  void client.drawioUpdate(s, s, s, s, 'elk');
  // --- draw.io high-level semantic tools (#425 stage 3) ---
  void client.drawioEditCells(s, s, [{ op: 'delete', cellId: s }], s);
  void client.drawioFromGraph(
    s,
    { position: 'append', anchorNodeId: s },
    { nodes: [{ id: s, label: s }] },
    'LR',
    s,
    'full',
    s,
  );
  void client.drawioFromMermaid(
    s,
    { position: 'append', anchorNodeId: s },
    s,
    s,
  );
  // --- write (comment) ---
  void client.createComment(s, s, 'inline', s, s, s);
  void client.resolveComment(s, true);
}

/**
 * Per-user, per-request adapter that exposes Docmost READ operations to the
 * agent as AI SDK tools (STAGE A = read only).
 *
 * Each tool call goes loopback over the user's own access JWT, so Docmost CASL
 * enforces access on every request — there is NO extra authorization here
 * (§8.5). The client is built fresh per chat request and never shares the
 * cached embedded `/mcp` handler.
 *
 * SINGLE-WORKSPACE ASSUMPTION: the loopback host (127.0.0.1) does not resolve a
 * workspace subdomain, so this targets the default/first workspace only. The
 * embedded `/mcp` loopback path already calls loopback successfully, so this
 * works for single-workspace self-host.
 */
/**
 * #487: wall-clock cap for a SINGLE in-app tool call, env-tunable via
 * `AI_CHAT_INAPP_TOOL_CALL_CAP_MS`. Bounds a read tool that would otherwise
 * paginate for minutes and a content write whose collab commit hangs, and is the
 * per-call CAP half of the composite abort signal every in-app tool is wrapped
 * with (the other half is the turn's Stop signal). Default 2 minutes: generous
 * for a legitimate long read/write, tight enough that a stuck call cannot pin the
 * turn. The reconcile staleness floor (#487 commit 4) is derived as
 * max(2 x this cap, 15 min), so keep this well under that.
 */
export function inAppToolCallCapMs(): number {
  const raw = Number(process.env.AI_CHAT_INAPP_TOOL_CALL_CAP_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

/**
 * #588: hard byte cap for a RASTER attachment (png/jpeg/webp/gif) delivered to
 * the model as vision by the `viewImage` tool. A raster is passed through AS-IS
 * (no resize), so this bounds both the base64 the provider must ingest and the
 * per-turn memory. ~5 MiB is generous for a screenshot/diagram yet blocks a
 * pathological multi-MB upload. SVG has no analogous cap here: it is rasterized
 * by #586's `rasterizeSvgToPng`, whose own RASTER_MAX_SVG_BYTES input cap and
 * PNG pixel ceiling bound the output.
 */
export const VIEW_MAX_RASTER_BYTES = 5 * 1024 * 1024;

/**
 * #588 F1: per-run cap on the LIVE viewImage cache (images held for prepareStep
 * injection). Each live entry is re-injected into the provider request on every
 * step until the model speaks about it, so an unbounded cache — a prompt-injected
 * page telling the agent to view dozens of nodes before commenting — would hold
 * up to ~MAX_AGENT_STEPS x 5 MiB base64 AND re-send them all every step (O(N^2)).
 * Cap both the live count and the total held (base64) bytes; when full, viewImage
 * refuses with a model-visible note so the model must comment on what it has seen
 * (which evicts entries) before viewing more. Bytes are measured on the base64
 * string actually held (~1.33x the raw image size).
 */
export const VIEW_MAX_LIVE_IMAGES = 6;
export const VIEW_MAX_LIVE_BYTES = 24 * 1024 * 1024;

/** #588: the per-run cache value shape shared between `viewImage.execute` (which
 * WRITES the delivered image bytes, keyed by toolCallId) and the ai-chat
 * `prepareStep` injection (which READS them into an ephemeral user-role message).
 * A plain closure Map passed by reference — NOT experimental_context, which the
 * SDK marks immutable inside a tool execute. */
export interface ViewImageCacheEntry {
  data: string; // base64 of the image bytes
  mediaType: string; // e.g. 'image/png'
}
export type ViewImageCache = Map<string, ViewImageCacheEntry>;

/** #487: the composite signal's reason as an Error (informative thrown value). */
function inAppAbortReason(signal: AbortSignal): Error {
  const r = signal.reason;
  return r instanceof Error
    ? r
    : new Error(typeof r === 'string' ? r : 'In-app tool call aborted');
}

/**
 * The client surface {@link wrapInAppToolWithCap} drives (#487). Both methods are
 * OPTIONAL: the real loopback DocmostClient implements them (so a Stop/cap reaches
 * its pagination / pre-commit safe-points), but a client that omits them still
 * gets the OUTER guarantee — the race rejects on abort regardless. This keeps the
 * wrapper decoupled from the exact client shape (unit-test doubles need not stub
 * the plumbing).
 */
export interface ToolAbortSignalSink {
  setToolAbortSignal?(signal: AbortSignal | null): void;
  getToolAbortSignal?(): AbortSignal | null;
}

/**
 * #487: wrap an in-app tool so a Stop (the turn's `options.abortSignal`) OR the
 * per-call wall-clock cap REJECTS the call immediately, and so that SAME
 * composite signal reaches the client's pagination / pre-commit safe-points (via
 * `client.setToolAbortSignal`) — making a Stop stop the NEXT HTTP/WS call from
 * starting.
 *
 * Reuses the RACE pattern of `wrapToolWithCallTimeout` (mcp-clients.service.ts):
 * the call is raced against the composite signal, so on abort we reject in the
 * SAME tick and DISCARD the loser promise. Its network / collab teardown latency
 * therefore never blocks the turn — the supersede timeout W=10s (#487 commit 3)
 * relies on this abort->settle latency being milliseconds, not a socket teardown.
 * Awaiting the client's own signal-into-write path alone would NOT satisfy this
 * (the loser could still be tearing down a collab socket).
 *
 * The composite is SET on the client at entry and deliberately NOT restored on
 * unwind: after this wrapper rejects on abort, the ABANDONED loser promise keeps
 * running, and its safe-points read the client field — leaving the (aborted)
 * composite there is exactly what makes the loser's NEXT call throw and stop. The
 * next in-app tool call overwrites the field with its own fresh composite before
 * any of its safe-points run, so a stale settled signal never leaks forward.
 * SINGLE-WRITER by phase-1 assumption — see DocmostClientContext.toolAbortSignal
 * for the parallel-call caveat (#487).
 *
 * KNOWN LIMITATION (#487): a write tool that issues SEVERAL sequential collab
 * commits can be aborted BETWEEN commits, leaving a partially-applied operation.
 * Cancel guarantees "no NEW call starts", NOT "the write didn't land".
 */
export function wrapInAppToolWithCap(
  toolDef: Tool,
  client: ToolAbortSignalSink,
  capMs: number,
): Tool {
  const original = toolDef.execute;
  if (typeof original !== 'function') return toolDef;
  const execute = async (args: unknown, options: ToolCallOptions) => {
    const capController = new AbortController();
    const timer = setTimeout(() => {
      capController.abort(
        new Error(`In-app tool call exceeded the ${capMs}ms per-call cap`),
      );
    }, capMs);
    timer.unref?.();
    const composite = options?.abortSignal
      ? AbortSignal.any([options.abortSignal, capController.signal])
      : capController.signal;
    // Reject the MOMENT the composite fires, independent of whether `original`
    // ever settles (a hung collab write / read would otherwise pin the turn). The
    // losing `original` is left pending; Promise.race attaches a rejection
    // handler to both inputs so a late rejection is never unhandled.
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(inAppAbortReason(composite));
      if (composite.aborted) fail();
      else composite.addEventListener('abort', fail, { once: true });
    });
    // Publish the composite so the client's pagination / pre-commit safe-points
    // observe it (see the "not restored on unwind" rationale above). Guarded: a
    // client without the plumbing still gets the OUTER race guarantee below.
    client.setToolAbortSignal?.(composite);
    try {
      return await Promise.race([
        (original as (a: unknown, o: ToolCallOptions) => Promise<unknown>)(
          args,
          { ...options, abortSignal: composite },
        ),
        aborted,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return { ...toolDef, execute } as unknown as Tool;
}

/** #487: apply {@link wrapInAppToolWithCap} to every tool in a set. */
export function wrapInAppToolsWithCap(
  tools: Record<string, Tool>,
  client: ToolAbortSignalSink,
  capMs: number,
): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    out[name] = wrapInAppToolWithCap(t, client, capMs);
  }
  return out;
}

/** The exact past/ephemeral-tense note persisted as the viewImage tool result
 * (#588). It carries NO image bytes; the image itself is delivered out-of-band as
 * an ephemeral user-role message (prepareStep injection). The tense matters: on a
 * later replay this text must NOT make the model believe a live image is still
 * attached — it must re-call viewImage to see it again. English to match the
 * language convention of the neighbouring tool results. */
export const VIEW_IMAGE_NOTE =
  'The image was shown to you as a separate message on this step; it is NOT ' +
  'retained on later turns — call viewImage again to see it now.';

/** The raster MIME types the viewImage tool passes through to the model AS-IS
 * (byte cap only, no resize). Anything else is either SVG (rasterized) or
 * rejected as unsupported. */
const VIEW_RASTER_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

// --- embedded draw.io raster (issue #629) ---------------------------------
//
// SHARED CONTRACT duplicate. draw.io captions live in a browser-only
// `foreignObject`, so resvg-rasterizing a `.drawio.svg` yields garbage. The
// browser (Part A) embeds a real PNG of the diagram into the SVG's ROOT
// `data-raster="data:image/png;base64,<b64>"` attribute; viewImage PREFERS that
// PNG. `@docmost/mcp` (which owns the canonical extractor) is ESM-only and is
// reached from this CommonJS server ONLY via the dynamic loader — a static value
// import would downlevel to `require()` and fail at runtime. Per the
// no-shared-package convention (see docmost-client.loader.ts's SharedToolSpec /
// comment-signal mirrors), this small PURE helper is duplicated here with the
// SAME attribute constant and the SAME 8-byte PNG-signature validation.

/** Root SVG attribute carrying the browser-rendered PNG raster (issue #629). */
export const DRAWIO_RASTER_ATTR = 'data-raster';
const RASTER_DATA_URI_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
/** Cap the base64 length BEFORE decode so a hostile huge attribute never
 * allocates unbounded memory (8 MiB base64 ≈ 6 MiB PNG). */
const MAX_RASTER_BASE64_LENGTH = 8 * 1024 * 1024;

/** Read the `data-raster` attribute off the OPENING `<svg …>` tag ONLY (never a
 * nested element). Pure/string-level — no jsdom on the server. */
function readRootRasterAttr(svg: string): string | null {
  const openTag = /<svg\b[^>]*>/i.exec(svg);
  if (!openTag) return null;
  const m = new RegExp(`\\b${DRAWIO_RASTER_ATTR}\\s*=\\s*"([^"]*)"`, 'i').exec(
    openTag[0],
  );
  return m ? m[1] : null;
}

/**
 * Extract + VALIDATE the browser-embedded PNG raster from a `.drawio.svg`, or
 * null when there is no usable raster (absent, non-png mime, oversized, or bytes
 * that fail the PNG signature — a fake/corrupt raster must never pass as a PNG).
 * Mirror of `@docmost/mcp`'s extractDrawioRaster (issue #629).
 */
export function extractDrawioRaster(svg: string): Buffer | null {
  const raw = readRootRasterAttr(svg);
  if (raw == null) return null;
  const comma = raw.indexOf(',');
  if (comma === -1) return null;
  if (raw.slice(0, comma + 1) !== RASTER_DATA_URI_PREFIX) return null;
  const base64 = raw.slice(comma + 1);
  if (base64.length === 0 || base64.length > MAX_RASTER_BASE64_LENGTH) {
    return null;
  }
  const png = Buffer.from(base64, 'base64');
  if (png.length < PNG_SIGNATURE.length) return null;
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  return png;
}

/** Remove the `data-raster="…"` attribute from the opening `<svg …>` tag,
 * leaving `content=` byte-intact. Mirror of `@docmost/mcp`'s stripRasterAttr. */
export function stripRasterAttr(svg: string): string {
  const openTag = /<svg\b[^>]*>/i.exec(svg);
  if (!openTag) return svg;
  const tag = openTag[0];
  const stripped = tag.replace(
    new RegExp(`\\s*\\b${DRAWIO_RASTER_ATTR}\\s*=\\s*"[^"]*"`, 'i'),
    '',
  );
  if (stripped === tag) return svg;
  return (
    svg.slice(0, openTag.index) +
    stripped +
    svg.slice(openTag.index + tag.length)
  );
}

/**
 * The read-only client surface {@link runViewImage} needs (#588): resolve the
 * node's JSON (for its type + attrs.src) and pull the attachment bytes through
 * the guarded loopback fetch. A narrow Pick so unit tests can pass a tiny double.
 */
export type ViewImageClient = Pick<
  DocmostClientLike,
  'getNode' | 'fetchAttachmentBytes'
>;

export interface ViewImageResult {
  ok: true;
  mediaType: string;
  width?: number;
  height?: number;
  source: string;
  note: string;
}

/**
 * Core of the `viewImage` tool (#588), factored out for unit testing without a
 * live model/provider. Resolves the node, pulls its attachment bytes, classifies
 * by MIME, and — as a SIDE EFFECT — writes the ready-to-inject base64 image into
 * `cache` keyed by `toolCallId`. Returns a SMALL, byte-free result (persisted in
 * chat history) whose note is written in past/ephemeral tense so a later replay
 * never makes the model hallucinate a still-attached live image.
 *
 * Classification:
 *  - png/jpeg/webp/gif  -> passthrough; oversized (> VIEW_MAX_RASTER_BYTES) throws;
 *  - image/svg+xml (incl. a drawio node's `.drawio.svg`) -> a plain SVG is
 *    rasterized to PNG via #586's rasterizeSvgToPng (drawio node type is treated
 *    as SVG regardless of the served Content-Type). A `.drawio.svg` PREFERS its
 *    browser-embedded PNG raster (#629) when one is valid and in-budget; without
 *    a usable raster the behavior depends on `rasterEnabled` (see below);
 *  - anything else -> throws `unsupported type <mime>`.
 *
 * `rasterEnabled` mirrors DRAWIO_RASTER_ENABLED (#629). It ONLY affects a drawio
 * node that has NO usable embedded raster (missing OR oversized): with generation
 * ON the "open it in the editor and save" remediation is actionable, so we throw
 * that loud text instead of returning a captionless resvg render; with generation
 * OFF that advice is unactionable, so viewImage falls back to the pre-PR resvg
 * render (INERT). A valid in-budget embedded raster is used directly under BOTH
 * flags — consumption is unconditional. Plain SVGs ignore the flag entirely.
 *
 * getNode is called with format='json' DELIBERATELY: the markdown rendering drops
 * `attrs` (incl. the attachment `src`), so JSON is the only form that yields the
 * `/api/files/<id>/…` source both an image and a drawio node point at.
 */
export async function runViewImage(
  client: ViewImageClient,
  args: { pageId: string; node: string },
  toolCallId: string,
  cache: ViewImageCache,
  // #629: DRAWIO_RASTER_ENABLED mirror. Gates ONLY the drawio no-usable-raster
  // remediation (throw vs. inert resvg fallback); see the doc block above.
  rasterEnabled: boolean,
): Promise<ViewImageResult> {
  const res = (await client.getNode(args.pageId, args.node, 'json')) as {
    type?: string;
    node?: { attrs?: { src?: unknown } };
  };
  if (
    res?.type !== 'image' &&
    res?.type !== 'drawio' &&
    res?.type !== 'excalidraw'
  ) {
    throw new Error('node is not an image');
  }
  const src = res.node?.attrs?.src;
  if (typeof src !== 'string' || src.length === 0) {
    throw new Error('node has no image source');
  }

  const { buffer, mime } = await client.fetchAttachmentBytes(src);

  let data: Buffer;
  let mediaType: string;
  let width: number | undefined;
  let height: number | undefined;

  if (VIEW_RASTER_MIMES.has(mime)) {
    // Raster passthrough — no resize, byte cap only.
    if (buffer.length > VIEW_MAX_RASTER_BYTES) {
      throw new Error('image too large');
    }
    data = buffer;
    mediaType = mime;
  } else if (
    mime === 'image/svg+xml' ||
    res.type === 'drawio' ||
    res.type === 'excalidraw'
  ) {
    // SVG (incl. .drawio.svg / .excalidraw.svg). A .drawio.svg's captions live in
    // a browser-only `foreignObject`, so resvg-rasterizing the vector yields
    // garbage (#629) — hence it PREFERS a browser-embedded PNG raster. An
    // excalidraw SVG is itself VALID for resvg (real `<text>`), so #632 gives it
    // a correct degrade path: prefer an embedded raster if present, ELSE just
    // resvg the SVG. Excalidraw therefore NEVER takes drawio's flag-gated
    // "no raster -> throw" branch below (that stays `res.type === 'drawio'`).
    const svgText = buffer.toString('utf8');
    const embedded = extractDrawioRaster(svgText);
    if (embedded && embedded.length <= VIEW_MAX_RASTER_BYTES) {
      // A valid, in-budget embedded PNG raster: used directly — no resvg call,
      // width/height unknown. UNCONDITIONAL (independent of rasterEnabled) so
      // consumption of an already-embedded raster never regresses (#629).
      data = embedded;
      mediaType = 'image/png';
    } else if (res.type === 'drawio' && rasterEnabled) {
      // A drawio node with NO usable raster — missing (F1) OR oversized-but-valid
      // (F2). With generation ENABLED the remediation actually works, so do NOT
      // silently return a captionless vector rasterization; surface an explicit,
      // actionable text instead. (This also guards a flag-ON deploy whose
      // png-export server is broken — a flag-ON operational concern, throw is ok.)
      throw new Error(
        'this diagram has no embedded raster preview yet; open it in the ' +
          'draw.io editor and save it to generate one, then view it again',
      );
    } else {
      // A plain SVG image (flag-agnostic), OR — under flag-OFF — a drawio with no
      // usable raster (missing/oversized/stale). Generation is off (or this is a
      // plain SVG), so the "save to generate one" advice is unactionable: fall
      // back to the pre-PR resvg render (INERT). Strip any (stale/huge)
      // data-raster first so resvg does not choke on it, then rasterize the
      // vector via the #586 in-process rasterizer as before.
      const { png, width: w, height: h } = await rasterizeSvgToPng(
        stripRasterAttr(svgText),
      );
      data = png;
      mediaType = 'image/png';
      width = w;
      height = h;
    }
  } else {
    throw new Error('unsupported type ' + mime);
  }

  // Side effect: stash the ready-to-inject image for prepareStep, keyed by this
  // call's id so parallel viewImage calls never cross-talk. NOT returned — the
  // persisted result below carries no bytes.
  const encoded = data.toString('base64');
  // #588 F1: bound the live cache before stashing (see VIEW_MAX_LIVE_* above).
  // A prompt-injected page could otherwise make the agent hold and re-inject
  // dozens of multi-MiB images per turn. Refuse (model-visible) when adding this
  // image would exceed the count or byte budget; the model frees budget by
  // commenting on already-viewed images (which evicts their cache entries).
  const heldBytes = Array.from(cache.values()).reduce(
    (n, e) => n + e.data.length,
    0,
  );
  if (
    cache.size >= VIEW_MAX_LIVE_IMAGES ||
    heldBytes + encoded.length > VIEW_MAX_LIVE_BYTES
  ) {
    throw new Error(
      'too many images are being held this turn; comment on the ones you ' +
        'have already viewed so they are released, then call viewImage again',
    );
  }
  cache.set(toolCallId, { data: encoded, mediaType });

  return {
    ok: true,
    mediaType,
    width,
    height,
    source: args.node,
    note: VIEW_IMAGE_NOTE,
  };
}

@Injectable()
export class AiChatToolsService {
  private readonly logger = new Logger(AiChatToolsService.name);

  constructor(
    private readonly tokenService: TokenService,
    private readonly aiService: AiService,
    private readonly pageEmbeddingRepo: PageEmbeddingRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    // Shared singleton in-RAM blob store backing the stash tool.
    private readonly sandboxStore: SandboxStore,
    // #599: resolves the ACTIVE embedding generation, so the RAG read stays in
    // lockstep with SearchService's vector arm (both serve the active fingerprint,
    // never a half-built target one).
    private readonly embeddingGeneration: EmbeddingGenerationService,
    // #629: mirrors DRAWIO_RASTER_ENABLED. Gates only the loud "no raster yet"
    // remediation in viewImage's drawio branch — with generation ON the advice is
    // actionable, so a captionless resvg fallback is refused; with generation OFF
    // it would be unactionable, so viewImage stays INERT (pre-PR resvg fallback).
    // Consumption of a valid embedded raster stays unconditional either way.
    private readonly environmentService: EnvironmentService,
  ) {}

  /**
   * Construct the per-user loopback `DocmostClient` used to reach Docmost's REST
   * / collab surface AS the current user. Every call is scoped by the user's own
   * access JWT (CASL-enforced) and carries the signed agent provenance claim
   * ({ actor:'agent', aiChatId }) for both the access and collab tokens. Shared
   * by `forUser` (the agent toolset) and `exportPageMarkdown` (the #274
   * page-change detection path) so they use an identical authenticated route.
   */
  private async buildDocmostClient(
    user: User,
    sessionId: string,
    workspaceId: string,
    aiChatId: string,
    // #487: the returned client also carries the tool-cancellation plumbing
    // (setToolAbortSignal/getToolAbortSignal). These are host plumbing, NOT part
    // of the tool-execute surface (DocmostClientMethod), so they are surfaced here
    // as an intersection rather than by widening that Pick — keeping the
    // positional-call drift-guard (#446) scoped to the actual tool methods.
  ): Promise<DocmostClientLike & ToolAbortSignalSink> {
    const apiUrl =
      process.env.MCP_DOCMOST_API_URL ||
      `http://127.0.0.1:${process.env.PORT || 3000}/api`;

    // BARE access JWT carrying the agent provenance claim (the client adds the
    // "Bearer " prefix and re-calls this on a 401). Minted against the live
    // session so jwt.strategy validates it (§15[C1]); the signed actor/aiChatId
    // drives the REST write provenance (create/rename/move page, comment
    // create/resolve) server-side.
    const getToken = () =>
      this.tokenService.generateAccessToken(user, sessionId, {
        actor: 'agent',
        aiChatId,
      });

    // Provenance COLLAB token for content mutations (which go over the collab
    // websocket). Signed with the same agent claim so onAuthenticate ->
    // onStoreDocument record 'agent'/aiChatId on the page (§6.6/§15 C2). The
    // client routes every content mutation through this provider instead of
    // POST /auth/collab-token.
    const getCollabToken = () =>
      this.tokenService.generateCollabToken(user, workspaceId, {
        actor: 'agent',
        aiChatId,
      });

    // Bind the stash tool to the shared in-RAM SandboxStore. The store owns the
    // anonymous-URL composition (putAndLink) and the live/evict probes the MCP
    // package needs to keep its mirror counts honest under FIFO eviction (the
    // package never touches env or the store). asSink() centralizes the uri↔id
    // mapping next to putAndLink, shared with the embedded-MCP wiring site.
    const { DocmostClient } = await loadDocmostMcp();
    return new DocmostClient({
      apiUrl,
      getToken,
      getCollabToken,
      sandbox: this.sandboxStore.asSink(),
    });
  }

  /**
   * Export a page's current Markdown (meta + body + comment threads) via the
   * SAME loopback path the `exportPageMarkdown` tool uses (#274). Used by the
   * per-turn page-change detection to render both the snapshot end and the
   * current end identically, so formatting never pollutes the diff. Access is
   * CASL-enforced by the user's JWT: a page the user cannot read throws.
   */
  async exportPageMarkdown(
    user: User,
    sessionId: string,
    workspaceId: string,
    aiChatId: string,
    pageId: string,
  ): Promise<string> {
    const client = await this.buildDocmostClient(
      user,
      sessionId,
      workspaceId,
      aiChatId,
    );
    return client.exportPageMarkdown(pageId);
  }

  /**
   * Build the IN-APP deferred <tool_catalog> entries (#332): one "name — purpose"
   * line per DEFERRED tool, merging the per-layer INLINE_TOOL_TIERS with the
   * shared registry's own catalogLine. Loads @docmost/mcp for the shared specs
   * (memoized). Core tools are always active and are NOT listed here. External
   * MCP tools are catalogued separately by the caller (they are runtime-scoped).
   */
  async getInAppDeferredCatalog(): Promise<ToolCatalogEntry[]> {
    const { sharedToolSpecs } = await loadDocmostMcp();
    return buildInAppDeferredCatalog(sharedToolSpecs);
  }

  async forUser(
    user: User,
    sessionId: string,
    // workspaceId scopes the provenance collab token (which is workspace-bound),
    // and documents the single-workspace assumption; the loopback REST client is
    // scoped by the user's JWT, not by an explicit workspace argument.
    workspaceId: string,
    // The resolved AI chat id. Threaded into both provenance tokens so every
    // agent write (REST + collab) records { actor:'agent', aiChatId } off a
    // SIGNED claim — non-spoofable, never a client body field (§6.5/§6.6).
    aiChatId: string,
    // The page the user currently has open (from the request context), exposed
    // to the model via getCurrentPage. Optional and last so existing callers
    // keep compiling. Kept proxy-robust: the model can CALL for the current
    // page instead of relying on it surviving in the system prompt text. The
    // `selection` (#388) is already sanitized + nested by resolveOpenPageContext.
    openedPage?: {
      id?: string;
      title?: string;
      selection?: SelectionContext | null;
    } | null,
    // #588: env-gated `viewImage` vision tool. When false the tool is NOT
    // registered at all (fail-closed) — the SAME flag gates the prepareStep image
    // injection on the caller side, so an off flag means neither the tool nor any
    // injection exists. Default false so existing callers keep the old surface.
    viewImageEnabled = false,
    // #588: per-run cache the viewImage.execute writes into (keyed by toolCallId),
    // read by the caller's prepareStep to inject the image as an ephemeral
    // user-role message. Shared by reference (a plain closure Map) — see
    // ViewImageCache. Omitted (or the flag off) => no viewImage tool.
    viewImageCache?: ViewImageCache,
  ): Promise<Record<string, Tool>> {
    // Build the per-user loopback client (carrying the access + collab
    // provenance tokens) and load the shared tool-spec registry. Client
    // construction is shared with the page-change detection path (#274) via
    // buildDocmostClient so both go over the exact same authenticated route.
    // searchShapes / getGuideSection (#424) are the PURE, no-network helpers
    // backing drawioShapes / drawioGuide. They are `inlineBothHosts` specs (no
    // canonical execute — their catalog loader uses import.meta and can't be
    // value-imported into the zod-agnostic tool-specs.ts under the server's
    // commonjs type-check), so the shared registry loop below SKIPS them and this
    // service wires them inline (see drawioShapes/drawioGuide entries), mirroring
    // how index.ts registers them on the standalone MCP host.
    const {
      sharedToolSpecs,
      createCommentSignalTracker,
      createListCommentsProbe,
      searchShapes,
      getGuideSection,
    } = await loadDocmostMcp();
    const client = await this.buildDocmostClient(
      user,
      sessionId,
      workspaceId,
      aiChatId,
    );

    // Build an ai-SDK tool from a shared, zod-agnostic spec. The spec owns the
    // canonical description + (optional) schema builder, which is invoked with
    // THIS layer's zod (v4); only the execute body is supplied per call. No-arg
    // specs (no buildShape) get an empty object schema.
    const sharedTool = (
      spec: SharedToolSpec,
      execute: Tool['execute'],
    ): Tool =>
      tool({
        description: spec.description,
        // Wrap via modelFriendlyInput so a dropped/invalid parameter (e.g. a
        // pageId omitted in a parallel batch, #190) yields a clear, actionable
        // tool error instead of zod's raw text. No-arg specs still get an empty
        // object schema.
        inputSchema: modelFriendlyInput(
          spec.buildShape ? (spec.buildShape(z) as z.ZodRawShape) : {},
        ),
        execute,
      });

    // The in-app toolset. It starts with the tools kept INLINE here for a
    // documented per-layer reason: an intentional behaviour/schema divergence from
    // the standalone MCP surface (searchPages' hybrid RRF,
    // transformPage's guardrailed shorter schema), a name clash the shared
    // registry forbids (in-app `getTable` verb-first vs the MCP noun-first
    // `tableGet` — the registry requires mcpName === inAppKey), per-request
    // state the registry loop cannot provide
    // (getCurrentPage reads the resolved openedPage; searchPages closes over the
    // per-request user/embedding deps), or a tool with no MCP twin
    // (listSidebarPages/getComment/getPageHistory). Every SHARED tool is then added
    // by the registry loop below (see it), so there is exactly one arg-mapping per
    // shared tool and it can never drift from the MCP host again (#445).
    const tools: Record<string, Tool> = {
      // INTENTIONAL per-transport divergence (not in the shared registry): this
      // in-app search runs a semantic + keyword hybrid (RRF) with in-process
      // access control and a tuned schema (limit 1-20); the standalone MCP
      // `search` is a plain REST full-text search (limit up to 100). Different
      // behaviour AND schema, so kept per-layer.
      searchPages: tool({
        description:
          'Search the wiki for pages relevant to a query. Combines exact ' +
          'keyword/identifier matching with semantic meaning and returns the ' +
          'most relevant pages with a short snippet, best match first. ' +
          "Rephrase the user's question into a focused search query (key terms " +
          'and entities), not a full sentence. If the first results look weak ' +
          'or incomplete, search again with different wording or synonyms ' +
          'before answering.',
        inputSchema: modelFriendlyInput({
          query: z.string().describe('The search query.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe('Maximum number of results (1-20).'),
        }),
        execute: async ({ query, limit }) => {
          const trimmed = (query ?? '').trim();
          if (!trimmed) return [];

          const cap = limit ?? 10;

          // Loopback REST full-text fallback. Used when AI search is not
          // configured, embedding fails, there are no accessible spaces, or the
          // hybrid query returns nothing — so keyword search always works.
          const fallback = async () => {
            // search(query, spaceId?, limit?) -> { items, success }.
            // Items are filterSearchResult(): { id, title, highlight, ... }.
            const result = await client.search(trimmed, undefined, cap);
            const items = Array.isArray(result?.items) ? result.items : [];
            // Keep the payload token-efficient: id + title + a short snippet.
            return items.map((raw) => {
              const item = raw as {
                id?: string;
                slugId?: string;
                title?: string;
                highlight?: string;
              };
              return {
                id: item.id ?? item.slugId,
                title: item.title ?? '',
                snippet: snippet(item.highlight),
              };
            });
          };

          // HYBRID path: fuse semantic (vector) + lexical (full-text) rankings
          // via RRF. Over-fetch candidates so the page-permission post-filter
          // still leaves enough results.
          const candidates = Math.min(Math.max(cap * 5, 50), 200);

          // 1) Embed the query through the SAME funnel the search subsystem uses
          //    (#571, #599): it resolves the active provider, applies its QUERY
          //    prefix (so the query lives in the same prefixed space as the
          //    indexer's passage-prefixed docs), and returns the fingerprint of the
          //    ACTIVE generation — which we thread into hybridSearch so the vector
          //    CTE only fuses against the generation that is actually being served
          //    (never stale cross-provider vectors, and never the half-built TARGET
          //    generation of an in-flight reindex: during a swap the active pointer
          //    still names the OLD generation, so RAG keeps full recall exactly like
          //    search does). Unconfigured embeddings (or any embedding error) routes
          //    to the REST full-text fallback instead of erroring.
          let queryVector: number[];
          let fingerprint: string;
          try {
            const embedded =
              await this.embeddingGeneration.embedQueryForActiveGeneration(
                workspaceId,
                trimmed,
              );
            if (!embedded?.vector) return await fallback();
            // #599 (D2): the served generation was produced by a DIFFERENT model
            // than the one that just embedded this query. Their vectors live in two
            // independently trained spaces, so a cosine between them is noise and the
            // RRF fusion would rank arbitrary pages above genuine lexical hits. Fall
            // back to the REST full-text search (lexical only) until the reindex of
            // the new model completes and the pointer flips — exactly what
            // SearchService does with its vector arm.
            if (embedded.generation.modelChanged) {
              this.logger.warn(
                `searchPages: embedding model changed (active=${
                  embedded.generation.activeModel ?? 'unknown'
                } config=${embedded.generation.targetModel}); the served generation is ` +
                  `not comparable with the new model — falling back to full-text search ` +
                  `until the reindex completes.`,
              );
              return await fallback();
            }
            queryVector = embedded.vector;
            fingerprint = embedded.fingerprint;
          } catch (err) {
            if (!(err instanceof AiEmbeddingNotConfiguredException)) {
              // Never leak provider/key details; log generically and fall back.
              this.logger.warn(
                `searchPages embed failed: ${
                  err instanceof Error ? err.message : 'unknown error'
                }`,
              );
            }
            return await fallback();
          }

          // 2) ACCESS CONTROL: the hybrid query runs IN-PROCESS (a direct
          //    pgvector + full-text query), so unlike the loopback REST tools it
          //    does NOT get CASL for free. Scope to the spaces the user can read
          //    (member spaces + groups), mirroring SearchService.searchPage. No
          //    accessible spaces => fall back to REST (which is CASL-scoped).
          const accessibleSpaceIds =
            await this.spaceMemberRepo.getUserSpaceIds(user.id);
          if (accessibleSpaceIds.length === 0) return await fallback();

          // 3) Hybrid RRF retrieval, scoped to the workspace AND accessible
          //    spaces.
          const hits = await this.pageEmbeddingRepo.hybridSearch(
            workspaceId,
            queryVector,
            trimmed,
            accessibleSpaceIds,
            candidates,
            fingerprint,
          );
          if (hits.length === 0) return await fallback();

          // 4) Page-level permission post-filter: an accessible space does not
          //    imply every page in it is accessible (restricted pages). Mirror
          //    SearchService.searchPage's filterAccessiblePageIds pass.
          const pageIds = Array.from(new Set(hits.map((h) => h.pageId)));
          const accessibleIds =
            await this.pagePermissionRepo.filterAccessiblePageIds({
              pageIds,
              userId: user.id,
            });
          const accessibleSet = new Set(accessibleIds);

          // Keep the best (first — hits are ordered by fused score desc) chunk
          // per page, dropping any page the user cannot access, capped to `cap`.
          return selectAccessibleHits(hits, accessibleSet, cap);
        },
      }),

      getCurrentPage: tool({
        description:
          'Return the page the user is currently viewing — i.e. what "this page", ' +
          '"the current page", or "here" refers to — plus the text the user ' +
          'currently has SELECTED on that page (what "this", "here", "the selected ' +
          'fragment" refers to), or selection: null when nothing is selected. The ' +
          'selection is a client-side snapshot taken when the user sent the message ' +
          'and includes the ids of the blocks it covers plus surrounding context; ' +
          'it is NOT verified server-side — locate it in the page (searchInPage / ' +
          'getNode) before editing. Returns page: null if the user is not currently ' +
          'on a page. Call this first whenever the user refers to the current page ' +
          'or a selected fragment without giving an explicit id.',
        inputSchema: modelFriendlyInput({}),
        execute: async () => resolveCurrentPageResult(openedPage),
      }),

      // --- WRITE tools (all reversible — history/trash; §6.5 / D3) ---
      //
      // NOTE (issue #411): the plain-Markdown full-body-replace tool is no longer
      // inline here — it moved to @docmost/mcp's SHARED_TOOL_SPECS as
      // `updatePageMarkdown` (was inline `updatePageContent`) so it registers on
      // BOTH the external MCP and the in-app agent. The registry loop below adds
      // it under its inAppKey. importPageMarkdown stays a shared spec too (now
      // inAppOnly — dropped from the external MCP surface, kept in-app).

      listSidebarPages: tool({
        description:
          'List sidebar pages for a space. With no pageId, returns the ' +
          "space's ROOT pages; with a pageId, returns that page's direct " +
          'CHILDREN.',
        inputSchema: modelFriendlyInput({
          spaceId: z.string().describe('The id of the space.'),
          pageId: z
            .string()
            .optional()
            .describe(
              'Optional page id; when given, lists that page\'s direct children.',
            ),
        }),
        execute: async ({ spaceId, pageId }) =>
          await client.listSidebarPages(spaceId, pageId),
      }),

      // NOT shared (kept inline): the MCP tool name `tableGet` is noun-first
      // while this key is `getTable` (verb-first), so it cannot satisfy the
      // shared registry's `mcpName === inAppKey` convention (#412). Its
      // reference parameter is still named `table` (was `tableRef`) so it matches
      // the migrated table row/cell tools below.
      getTable: tool({
        description:
          'Read a table as a matrix of cell texts (plus a parallel cellIds ' +
          'matrix so cells can be addressed for rich edits).',
        inputSchema: modelFriendlyInput({
          pageId: z.string().describe('The id of the page.'),
          table: z
            .string()
            .describe(
              '"#<index>" from the page outline, or a block id of any node ' +
                'inside the table.',
            ),
        }),
        execute: async ({ pageId, table }) =>
          await client.getTable(pageId, table),
      }),

      getComment: tool({
        description: 'Fetch a single comment by id (content as Markdown).',
        inputSchema: modelFriendlyInput({
          commentId: z.string().describe('The id of the comment.'),
        }),
        execute: async ({ commentId }) => await client.getComment(commentId),
      }),

      getPageHistory: tool({
        description:
          'Fetch a single page-history version including its lossless ' +
          'ProseMirror content.',
        inputSchema: modelFriendlyInput({
          historyId: z.string().describe('The id of the history version.'),
        }),
        execute: async ({ historyId }) =>
          await client.getPageHistory(historyId),
      }),

      // --- WRITE tools (added; reversible via page history/trash) ---

      // INTENTIONAL per-transport divergence (not shared): deliberately omits the
      // `deleteComments` schema field (comment-deletion guardrail) and carries a
      // much shorter description; the standalone MCP `docmostTransform` exposes
      // the full helper catalogue. Different schema, so kept per-layer.
      transformPage: tool({
        description:
          'Run a sandboxed JS transform of the form `(doc, ctx) => doc` over a ' +
          "page's ProseMirror document for complex/scripted rewrites. dryRun " +
          '(default true) previews a diff WITHOUT writing; set dryRun:false to ' +
          'apply. Helpers live on `ctx.helpers`, not on `ctx` (e.g. ' +
          '`ctx.helpers.getList` finds an id-less node). ' +
          'Reversible: applying creates a new page-history snapshot.',
        inputSchema: modelFriendlyInput({
          pageId: z.string().describe('The id of the page to transform.'),
          transformJs: z
            .string()
            .describe('The JS transform body: `(doc, ctx) => doc`.'),
          dryRun: z
            .boolean()
            .optional()
            .describe('Preview the diff without writing (default true).'),
        }),
        // GUARDRAIL: the schema deliberately omits `deleteComments`, and the
        // execute below NEVER passes it, so the client's comment-deletion path
        // stays unreachable from the agent.
        execute: async ({ pageId, transformJs, dryRun }) =>
          await client.transformPage(pageId, transformJs, { dryRun }),
      }),
    };

    // Add EVERY shared tool from the zod-agnostic registry in one loop (#445).
    // The spec owns the canonical arg->client mapping; this host only decides
    // WHICH mapping to run and returns its value directly (no envelope). For each
    // spec:
    //   - skip `mcpOnly` specs (they belong to the standalone MCP host only);
    //   - skip `inlineBothHosts` specs (drawioShapes / drawioGuide): they carry
    //     no execute and are wired INLINE just below, calling the pure helpers;
    //   - use `inAppExecute` when the spec declares a DELIBERATE per-layer
    //     difference (a projected result shape, a different guardrail message);
    //   - otherwise use the canonical `execute` (raw client result, identical to
    //     the MCP host's before it wraps it as JSON).
    // The execute receives the AI-SDK-validated, type-erased input; the spec reads
    // the same fields its buildShape declares. This is the SINGLE place the in-app
    // arg mapping lives — it can no longer silently drift from the MCP host.
    for (const spec of Object.values(sharedToolSpecs)) {
      if (spec.mcpOnly) continue;
      if (spec.inlineBothHosts) continue;
      const run = spec.inAppExecute ?? spec.execute;
      // Guaranteed present by assertEverySpecIsRegisterable() (#494), which runs
      // at tool-specs module load and throws if a non-inline spec the in-app host
      // registers carries neither inAppExecute nor execute — so this can no longer
      // silently drop a mis-declared tool. Kept as a type-narrowing guard.
      if (!run) continue;
      tools[spec.inAppKey] = sharedTool(
        spec,
        (async (args) =>
          run(client, args as Record<string, unknown>)) as Tool['execute'],
      );
    }

    // drawioShapes / drawioGuide (#424): `inlineBothHosts` registry specs wired
    // here with the SAME schema+description the shared spec pins, but calling the
    // pure searchShapes / getGuideSection helpers off the loaded @docmost/mcp
    // module — they are not client methods and their catalog loader uses
    // import.meta, so they cannot live in the zod-agnostic shared execute. The raw
    // result is identical to the MCP host's (which wraps it as JSON text); here
    // the in-app host returns it plain, exactly like every other shared tool.
    tools[sharedToolSpecs.drawioShapes.inAppKey] = sharedTool(
      sharedToolSpecs.drawioShapes,
      async ({ query, category, limit }) => {
        const results = searchShapes(query, { category, limit });
        return { query, count: results.length, results };
      },
    );
    tools[sharedToolSpecs.drawioGuide.inAppKey] = sharedTool(
      sharedToolSpecs.drawioGuide,
      async ({ section }) => getGuideSection(section),
    );

    // viewImage (#588): IN-APP ONLY, env-gated, read-only. Registered inline here
    // (like drawioShapes/drawioGuide) and ONLY when the caller both enabled the
    // feature AND supplied the per-run cache — fail-closed. It delivers a node's
    // image to the model AS VISION on ANY provider by writing the image bytes into
    // `viewImageCache` (keyed by toolCallId); the ai-chat prepareStep injects them
    // as an ephemeral user-role message. Deliberately NOT in SHARED_TOOL_SPECS and
    // NOT on the public-share `forShare` toolset. The tool result itself carries no
    // bytes (see runViewImage / VIEW_IMAGE_NOTE). Access stays CASL-enforced by the
    // user's own JWT on GET /api/files/:id (validateCanView) — this adds no auth.
    if (viewImageEnabled && viewImageCache) {
      tools.viewImage = tool({
        description:
          'View an image node from a page so you can SEE it (vision). Given a ' +
          'pageId and a node reference ("#<index>" from the page outline — image ' +
          'and drawio nodes carry no id in the schema), the image is shown to you as a ' +
          'separate message on THIS step only. Raster images (png/jpeg/webp/gif) ' +
          'are shown as-is; a plain SVG is rendered to PNG. A draw.io diagram is ' +
          'shown from its embedded PNG preview when it has one; otherwise, ' +
          'depending on server config, you get a rendered fallback or an error ' +
          'telling you to open and save the diagram in the editor first. ' +
          'The image is NOT retained on later turns — call viewImage again if you ' +
          'need to see it after this turn. Use it to answer questions about what ' +
          'an image, screenshot, or diagram actually depicts.',
        inputSchema: modelFriendlyInput({
          pageId: z.string().min(1).describe('The id of the page.'),
          node: z
            .string()
            .min(1)
            .describe(
              'The image/drawio node reference: "#<index>" for a top-level block ' +
                'from the page outline (these nodes carry no id in the schema).',
            ),
        }),
        execute: async ({ pageId, node }, { toolCallId }) =>
          runViewImage(
            client,
            { pageId, node },
            toolCallId,
            viewImageCache,
            // #629: gates ONLY the drawio no-usable-raster remediation. Read here
            // (the call site holds the NestJS EnvironmentService) so a valid raster
            // is still consumed unconditionally regardless of the flag.
            this.environmentService.isDrawioRasterEnabled(),
          ),
      });
    }

    // Passive "new comments: N" signal (#417). PER-TURN state (forUser runs once
    // per turn), so the watermark starts now and only comments a human leaves
    // WHILE this turn runs are signalled — exactly the mid-turn loop; between-turn
    // comments stay the job of the <page_changed> snapshot + explicit
    // checkNewComments. The count SOURCE is the same CASL-scoped loopback client
    // as the tools (option 2, symmetric with the standalone MCP): a rate-limited
    // listComments over the working-set pages. Chosen over the DB-count (option 1)
    // deliberately — a CommentRepo dependency would change this service's
    // constructor arity and force edits to every existing spec, breaking the
    // "existing tests stay green unchanged" contract; the REST probe needs no new
    // dependency and reuses the CASL enforcement already on `client`. When the
    // loaded package predates #417 (factory undefined) or the loader is mocked in
    // a unit test, signalling is a pure no-op and results are byte-identical.
    // #487: wrap every in-app tool with the race-on-abort + per-call cap guard so
    // a Stop / cap rejects immediately AND reaches the client's write/pagination
    // safe-points. Applied as the OUTERMOST wrapper (over the comment-signal
    // wrapper below) so the race governs the whole call. The client carries the
    // per-call composite signal via setToolAbortSignal.
    const capMs = inAppToolCallCapMs();
    // The signal needs BOTH the tracker factory AND the shared count-source probe
    // factory (#494). Either being absent (a stale @docmost/mcp build or a mocked
    // loader) => signal disabled, tool results byte-identical.
    if (!createCommentSignalTracker || !createListCommentsProbe) {
      return wrapInAppToolsWithCap(tools, client, capMs);
    }

    // Shared probe (#494): the SAME factory the standalone MCP host uses, so the
    // in-app probe body is no longer a hand-mirror that could drift (counting the
    // full feed newer than the watermark, labelling a hit with the light page
    // title). `client` supplies the loopback listComments/getPageRaw reads.
    const tracker = createCommentSignalTracker({
      probe: createListCommentsProbe(
        client as unknown as Parameters<typeof createListCommentsProbe>[0],
      ),
    });

    return wrapInAppToolsWithCap(
      wrapToolsWithCommentSignal(tools, tracker),
      client,
      capMs,
    );
  }
}

/**
 * Wrap each in-app tool so a passive "new comments: N" line (#417) reaches the
 * MODEL without ever reshaping the tool's own output. NON-DESTRUCTIVE by design:
 *  - notes the call's `pageId` (if any) into the working set;
 *  - for a comment tool (listComments/checkNewComments/createComment) the result
 *    is tautological, so no signal is added and the watermark is advanced instead
 *    (the agent just consumed the feed);
 *  - `execute` ALWAYS returns the RAW original result. In AI SDK v6 that raw
 *    value is what streams to the UI and is persisted as the tool part's
 *    `output` (see apps/client `toolCitations`, which reads `output.id/title`
 *    and the searchPages array DIRECTLY), so `output` stays byte-identical to
 *    the no-signal path and citations are never lost.
 *  - the signal instead rides a SEPARATE channel the model sees but `output`
 *    consumers do not: `toModelOutput`, which the SDK invokes only when building
 *    the model-facing tool message (createToolModelOutput), independently of the
 *    streamed `output`. When a line exists we emit an MCP-style multi-part
 *    `content` result — the raw result as one text element plus the signal as a
 *    SECOND element — mirroring the standalone MCP surface's extra content
 *    element. With no line, `toModelOutput` reproduces the SDK's exact default
 *    (string -> text, else json), so the model sees the identical result too.
 * A per-`toolCallId` map bridges `execute` -> `toModelOutput` (both receive the
 * toolCallId), so parallel tool calls never cross-talk. Exported for unit
 * testing without a live model/transport.
 *
 * NOTE for future tool authors: this wrapper OWNS `toModelOutput` on every
 * wrapped tool, but it COMPOSES rather than discards a tool's OWN
 * `toModelOutput`. If a tool defines one, it is used as the base model output
 * (honored verbatim on the no-signal path; flattened and kept, with the signal
 * appended, on the signal path). A custom `toModelOutput` is therefore never
 * silently dropped.
 */
export function wrapToolsWithCommentSignal(
  tools: Record<string, Tool>,
  tracker: CommentSignalTrackerLike,
): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};
  // Bridges the dynamic per-call signal line from `execute` (where the tracker
  // runs) to `toModelOutput` (the model-only channel). Keyed by toolCallId so
  // concurrent tool calls cannot read each other's line; the entry is consumed
  // (deleted) the first time toModelOutput reads it.
  const pendingSignals = new Map<string, string>();

  // The SDK's DEFAULT model-output shape for a tool result, reproduced verbatim
  // so the no-signal path is model-identical to an unwrapped tool: a string
  // becomes text, anything else becomes json (undefined -> null, as toJSONValue).
  const defaultModelOutput = (output: unknown) =>
    typeof output === 'string'
      ? { type: 'text' as const, value: output }
      : { type: 'json' as const, value: (output ?? null) as unknown };

  // Flatten a BASE model-output (the tool's OWN toModelOutput result, or the SDK
  // default) into SDK `content` parts, so the passive signal can be appended as a
  // trailing text element WITHOUT discarding the base. Covers the three real SDK
  // shapes (text/json/content); falls back defensively for anything else. Every
  // returned item is a valid SDK content item (text, or a file part spread from
  // an existing `content` base).
  const modelOutputToParts = (base: unknown, rawOutput: unknown): unknown[] => {
    const b = base as { type?: string; value?: unknown };
    if (b?.type === 'text') {
      return [{ type: 'text' as const, text: b.value as string }];
    }
    if (b?.type === 'json') {
      // `?? null` keeps this symmetric with the fallback branch below: a tool that
      // (invalidly) returns {type:'json', value:undefined} would otherwise yield a
      // non-string text. No current tool defines toModelOutput, so this is defensive.
      return [{ type: 'text' as const, text: JSON.stringify(b.value ?? null) }];
    }
    if (b?.type === 'content' && Array.isArray(b.value)) {
      return [...b.value];
    }
    return [
      { type: 'text' as const, text: JSON.stringify(b?.value ?? rawOutput ?? null) },
    ];
  };

  for (const [name, toolDef] of Object.entries(tools)) {
    const originalExecute = toolDef.execute;
    // Capture the tool's OWN toModelOutput (if any) BEFORE we install ours. The
    // comment-signal wrapper OWNS `toModelOutput` on the wrapped tool, but it
    // COMPOSES rather than discards a tool-defined one: the base model output is
    // computed from `origToModelOutput` when present (see below), so a future
    // tool that ships its own `toModelOutput` is honored, not silently dropped.
    const origToModelOutput = toolDef.toModelOutput;
    if (typeof originalExecute !== 'function') {
      wrapped[name] = toolDef;
      continue;
    }
    wrapped[name] = {
      ...toolDef,
      execute: (async (args: unknown, opts: unknown) => {
        const pageId =
          args && typeof args === 'object'
            ? (args as { pageId?: unknown }).pageId
            : undefined;
        tracker.noteWorkingPage(
          typeof pageId === 'string' ? pageId : undefined,
        );

        const result = await (
          originalExecute as (a: unknown, o: unknown) => Promise<unknown>
        )(args, opts);

        // Excluded comment tool: consume the feed, never signal. Raw result.
        if (tracker.isExcludedTool(name)) {
          tracker.advanceWatermark();
          return result;
        }
        let line: string | null = null;
        try {
          line = await tracker.maybeSignal(name);
        } catch {
          line = null;
        }
        // Stash the line for toModelOutput (keyed by this call's id). The RAW
        // result is ALWAYS returned unchanged so `part.output` is byte-identical
        // to the no-signal path.
        const toolCallId =
          opts && typeof opts === 'object'
            ? (opts as { toolCallId?: unknown }).toolCallId
            : undefined;
        if (line && typeof toolCallId === 'string') {
          pendingSignals.set(toolCallId, line);
        }
        return result;
      }) as Tool['execute'],
      // Model-only delivery: append the signal as a SEPARATE content element,
      // leaving the streamed/persisted `output` untouched (mirrors MCP). This
      // OWNS toModelOutput but COMPOSES the tool's own (origToModelOutput) into
      // the base, so a custom toModelOutput is honored on BOTH paths.
      toModelOutput: ((info: {
        toolCallId?: string;
        input?: unknown;
        output?: unknown;
      }) => {
        const { toolCallId, output } = info;
        const line =
          typeof toolCallId === 'string'
            ? pendingSignals.get(toolCallId)
            : undefined;
        if (typeof toolCallId === 'string' && line !== undefined) {
          pendingSignals.delete(toolCallId);
        }
        // BASE = the authoritative model-facing representation of THIS tool's
        // result: the tool's own toModelOutput when it defined one, else the
        // reproduced SDK default (string -> text, else json).
        const base = origToModelOutput
          ? (origToModelOutput as (i: unknown) => unknown)(info)
          : defaultModelOutput(output);
        // No signal: return the BASE unchanged — byte-identical to what the SDK
        // (or the tool's own toModelOutput) would have produced.
        if (!line) return base;
        // Signal present: flatten BASE into content parts, then append the
        // signal as a trailing text element — the model sees BOTH the tool's own
        // model output AND the signal, with no `.result` wrapper to dig under.
        return {
          type: 'content' as const,
          value: [
            ...modelOutputToParts(base, output),
            { type: 'text' as const, text: line },
          ],
        };
      }) as Tool['toModelOutput'],
    } as Tool;
  }
  return wrapped;
}

/** A single hybrid-search hit: the minimal shape selectAccessibleHits needs. */
export interface SearchHitLike {
  pageId: string;
  title: string | null;
  content: string;
}

/**
 * Post-filter hybrid-search hits into the agent-facing result list. This is the
 * CASL leak guard for the in-process hybrid search: the hits come from a direct
 * pgvector + full-text query that does NOT get CASL for free, so an accessible
 * SPACE does not imply every page in it is accessible (restricted pages).
 *
 * Given `hits` (ordered by fused score desc), the `accessibleSet` of page ids
 * the user may read, and `cap`, it keeps the BEST (first) chunk per page, drops
 * any page not in `accessibleSet`, and caps the output at `cap`. Pure — no I/O.
 */
export function selectAccessibleHits(
  hits: readonly SearchHitLike[],
  accessibleSet: Set<string>,
  cap: number,
): { id: string; title: string; snippet: string }[] {
  const seen = new Set<string>();
  const results: { id: string; title: string; snippet: string }[] = [];
  for (const hit of hits) {
    if (!accessibleSet.has(hit.pageId)) continue;
    if (seen.has(hit.pageId)) continue;
    seen.add(hit.pageId);
    results.push({
      id: hit.pageId,
      title: hit.title ?? '',
      snippet: snippet(hit.content),
    });
    if (results.length >= cap) break;
  }
  return results;
}

/**
 * Trim a search highlight/snippet to a token-efficient length. The highlight
 * may contain `<b>` markers from the search backend; they are harmless to the
 * model but we cap the overall length so a long page does not bloat the tool
 * result.
 */
function snippet(text: string | undefined): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  const MAX = 300;
  return text.length > MAX ? `${text.slice(0, MAX)}…` : text;
}
