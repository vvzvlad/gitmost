import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { SharedToolSpec } from './docmost-client.loader';

/**
 * Deferred tool loading for the in-app AI chat (#332).
 *
 * The agent otherwise sends ALL ~41 tool definitions on EVERY model call every
 * step, bloating context. Instead we split the in-app tools into two tiers:
 *
 *  - CORE (hot, always active): frequent OR tiny tools whose full schema is
 *    always visible, plus the `loadTools` meta-tool. Deferring a one-line tool is
 *    pure loss, so tiny tools stay core even if rare.
 *  - DEFERRED (loaded on demand): the fat/rare tools + ALL external MCP tools by
 *    default. The model sees only a compact <tool_catalog> (name — purpose) and
 *    calls `loadTools(names)` to ACTIVATE a tool's full schema for the NEXT step
 *    (one extra round-trip on first use).
 *
 * This module is the single source of truth for the IN-APP tiering:
 *  - CORE_TOOL_KEYS / CORE_TOOL_SET — the authoritative core list (used by
 *    prepareAgentStep to build per-step `activeTools`).
 *  - INLINE_TOOL_TIERS — tier + catalogLine for the per-layer INLINE tools (the
 *    ones NOT in @docmost/mcp's SHARED_TOOL_SPECS, which carry their own).
 *  - buildInAppDeferredCatalog / buildExternalToolCatalog — assemble the
 *    <tool_catalog> deferred lines.
 *  - applyLoadTools / makeLoadToolsTool — the loadTools meta-tool.
 *
 * The tier/catalogLine fields on SHARED_TOOL_SPECS are IN-APP metadata only; the
 * external /mcp server ignores them and exposes every tool normally.
 */

/** A single rendered <tool_catalog> line: the tool name + its "name — purpose". */
export interface ToolCatalogEntry {
  /** Exact tool name the model must pass to loadTools. */
  name: string;
  /** Hand-written (in-app) or derived (external) "name — purpose" line. */
  catalogLine: string;
}

/**
 * CORE (always-active) in-app tool keys — 13 frequent/tiny tools + `searchInPage`
 * (#330) + `insertFootnote` (#410) + `getTree`/`getPageContext` (#443).
 * `searchInPage` is core because it is frequent for the editorial roles this
 * feature targets; `insertFootnote` is core so the footnote tool is NOT hidden
 * while its natural sibling `editPageText` is always active (that asymmetry is
 * exactly what pushed the agent to write literal `^[...]`). `getTree` and
 * `getPageContext` are the single-call navigation/lookup tools — core so the
 * agent never has to loadTools just to orient itself. `loadTools` is active too
 * but is not a normal tool key (it is added to activeTools separately).
 */
export const CORE_TOOL_KEYS = [
  'searchPages',
  'listPages',
  'listSpaces',
  'getWorkspace',
  'getCurrentPage',
  'getPage',
  'getOutline',
  'getNode',
  'createComment',
  'getComment',
  'listComments',
  'resolveComment',
  'editPageText',
  // #330 searchInPage — frequent for editorial sweeps; core despite predating
  // the issue's tier list.
  'searchInPage',
  // #410 insertFootnote — core so pinpoint citations to already-written text
  // don't degrade into literal `^[...]`; kept symmetric with editPageText.
  'insertFootnote',
  // #443 getTree + getPageContext — cheap single-call navigation/lookup tools
  // (the core listPages even points to getTree); core so the agent never has
  // to loadTools just to orient itself.
  'getTree',
  'getPageContext',
] as const;

/** O(1) membership test for the core tier. */
export const CORE_TOOL_SET: ReadonlySet<string> = new Set(CORE_TOOL_KEYS);

/** The meta-tool name (always active alongside the core tools when enabled). */
export const LOAD_TOOLS_NAME = 'loadTools';

/**
 * loadTools description — VERBATIM from issue #332. Tells the model that the
 * catalog names EXIST, that loadTools only ACTIVATES them (callable next step),
 * and to load several at once.
 */
export const LOAD_TOOLS_DESCRIPTION =
  'loadTools — Load the full definitions of deferred tools from the <tool_catalog>\n' +
  'block in your instructions. Pass the EXACT tool names from the catalog; this\n' +
  'call only ACTIVATES them and returns { loaded: [...] } — the tools become\n' +
  'callable on your NEXT step. Load several names in one call when the task clearly\n' +
  'needs them. Unknown names are rejected with the list of valid ones.\n' +
  'Tools NOT listed in the catalog are CORE and ALWAYS active — call them directly,\n' +
  'NEVER via loadTools (e.g. createComment, listComments, resolveComment,\n' +
  'editPageText, searchInPage).';

/**
 * Tier + catalogLine for the INLINE ai-chat tools — those defined per-layer in
 * ai-chat-tools.service.ts and NOT present in @docmost/mcp's SHARED_TOOL_SPECS
 * (which carries its own tier/catalogLine). Together with the shared registry
 * this describes every in-app tool. catalogLine is present for core tools too
 * (uniformity), but only DEFERRED tools are rendered into the catalog.
 */
export const INLINE_TOOL_TIERS: Record<
  string,
  { tier: 'core' | 'deferred'; catalogLine: string }
> = {
  // --- core inline ---
  searchPages: {
    tier: 'core',
    catalogLine: 'searchPages — hybrid semantic + keyword search across the wiki.',
  },
  getCurrentPage: {
    tier: 'core',
    catalogLine:
      'getCurrentPage — the page the user is currently viewing and their current text selection on it.',
  },
  // NOTE: getPage and listPages moved to @docmost/mcp's SHARED_TOOL_SPECS
  // (#294); they carry their own tier ('core') + catalogLine there.
  // NOTE: createComment, listComments and resolveComment moved to
  // @docmost/mcp's SHARED_TOOL_SPECS (#294); they carry their own tier +
  // catalogLine there. getComment stays inline (MCP-only shape divergence is
  // n/a — it simply has no shared spec).
  getComment: {
    tier: 'core',
    catalogLine: 'getComment — fetch a single comment by id.',
  },

  // --- deferred inline ---
  // NOTE: createPage, renamePage, movePage, deletePage, updatePageJson and
  // exportPageMarkdown moved to @docmost/mcp's SHARED_TOOL_SPECS (#294); they
  // carry their own deferred tier + catalogLine there. updatePageContent moved
  // there too as updatePageMarkdown (#411) — a shared registry spec now, so it
  // is no longer an inline tier entry.
  listSidebarPages: {
    tier: 'deferred',
    catalogLine:
      "listSidebarPages — list a space's root pages or a page's direct children.",
  },
  getTable: {
    tier: 'deferred',
    catalogLine: 'getTable — read a table as a matrix of cell texts and cell ids.',
  },
  // NOTE: tableInsertRow, tableDeleteRow and tableUpdateCell moved to
  // @docmost/mcp's SHARED_TOOL_SPECS (#294); they carry their own deferred tier +
  // catalogLine there. getTable stays inline (its MCP name tableGet breaks the
  // snake_case(inAppKey) convention, so it has no shared spec).
  // NOTE: checkNewComments moved to @docmost/mcp's SHARED_TOOL_SPECS (#294);
  // it carries its own deferred tier + catalogLine there.
  getPageHistory: {
    tier: 'deferred',
    catalogLine:
      'getPageHistory — fetch one page-history version with its ProseMirror content.',
  },
  // NOTE: sharePage moved to @docmost/mcp's SHARED_TOOL_SPECS (#294); it carries
  // its own deferred tier + catalogLine there. transformPage stays inline (its
  // schema deliberately diverges — it omits the deleteComments field the MCP
  // docmostTransform exposes, a comment-deletion guardrail).
  transformPage: {
    tier: 'deferred',
    catalogLine: "transformPage — run a sandboxed JS transform over a page's document.",
  },
};

/**
 * Build the <tool_catalog> deferred lines for the IN-APP tools by merging the
 * two metadata sources: the per-layer INLINE_TOOL_TIERS and the shared registry
 * (SHARED_TOOL_SPECS, loaded at runtime). Only DEFERRED tools are included; core
 * tools are always active and never appear in the catalog. Pure — the caller
 * passes the loaded specs so this stays unit-testable.
 */
export function buildInAppDeferredCatalog(
  sharedToolSpecs: Record<string, SharedToolSpec>,
): ToolCatalogEntry[] {
  const entries: ToolCatalogEntry[] = [];
  // Inline deferred tools (hand-written lines).
  for (const [name, meta] of Object.entries(INLINE_TOOL_TIERS)) {
    if (meta.tier === 'deferred') {
      entries.push({ name, catalogLine: meta.catalogLine });
    }
  }
  // Shared deferred tools (line comes from the registry's own catalogLine).
  for (const [name, spec] of Object.entries(sharedToolSpecs)) {
    if (spec.tier === 'deferred' && spec.catalogLine) {
      entries.push({ name, catalogLine: spec.catalogLine });
    }
  }
  return entries;
}

/**
 * Cap an external tool's (untrusted) description into a short catalog purpose.
 * External MCP tools have no hand-written catalogLine, so we derive one from the
 * first sentence of the description, hard-capped. Whitespace is collapsed.
 */
export function shortenForCatalog(description: string, max = 140): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  if (!flat) return 'external tool';
  // Prefer the first sentence if it is reasonably short.
  const firstSentence = flat.split(/(?<=[.!?])\s/)[0];
  const base =
    firstSentence.length > 0 && firstSentence.length <= max
      ? firstSentence
      : flat;
  return base.length > max ? `${base.slice(0, max - 1).trimEnd()}…` : base;
}

/**
 * Build catalog lines for the EXTERNAL MCP tools (all deferred by default,
 * #332). Their names are the namespaced tool keys; the purpose is derived from
 * each tool's own description (no hand-written line exists). Pure.
 */
export function buildExternalToolCatalog(
  externalTools: Record<string, { description?: string } | undefined>,
): ToolCatalogEntry[] {
  return Object.entries(externalTools).map(([name, t]) => ({
    name,
    catalogLine: `${name} — ${shortenForCatalog(t?.description ?? '')}`,
  }));
}

/**
 * Pure core of the loadTools meta-tool. Validates the requested names against
 * the per-turn set of valid deferred names, ADDS the valid ones to the caller's
 * mutable `activatedTools` set (so they become callable next step), and returns
 * `{ loaded }`. An unknown name throws a clear error listing the valid deferred
 * names — surfaced to the model as a tool error so it can retry.
 */
export function applyLoadTools(
  names: unknown,
  activatedTools: Set<string>,
  validDeferredNames: ReadonlySet<string>,
): { loaded: string[] } {
  const requested = Array.isArray(names)
    ? names.filter((n): n is string => typeof n === 'string')
    : [];
  const unknown = requested.filter((n) => !validDeferredNames.has(n));
  if (unknown.length > 0) {
    const valid = [...validDeferredNames].sort().join(', ');
    throw new Error(
      `loadTools: unknown tool name(s): ${unknown.join(', ')}. ` +
        `Valid deferred tools are: ${valid || '(none)'}.`,
    );
  }
  for (const n of requested) activatedTools.add(n);
  return { loaded: requested };
}

/**
 * Build the loadTools AI-SDK tool bound to THIS turn's mutable state: the
 * `activatedTools` set (grown by execute, read by prepareAgentStep next step)
 * and the `validDeferredNames` set (every non-core tool in this turn's toolset,
 * incl. external MCP). Created per streamText call — never module-global.
 */
export function makeLoadToolsTool(
  activatedTools: Set<string>,
  validDeferredNames: ReadonlySet<string>,
): Tool {
  return tool({
    description: LOAD_TOOLS_DESCRIPTION,
    inputSchema: z.object({
      names: z
        .array(z.string())
        .describe(
          'EXACT deferred tool names from the <tool_catalog> to activate for ' +
            'your next step.',
        ),
    }),
    execute: async ({ names }) =>
      applyLoadTools(names, activatedTools, validDeferredNames),
  });
}
