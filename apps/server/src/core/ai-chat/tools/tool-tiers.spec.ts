import {
  CORE_TOOL_KEYS,
  CORE_TOOL_SET,
  LOAD_TOOLS_NAME,
  LOAD_TOOLS_DESCRIPTION,
  INLINE_TOOL_TIERS,
  buildInAppDeferredCatalog,
  buildExternalToolCatalog,
  shortenForCatalog,
  applyLoadTools,
} from './tool-tiers';
// The real shared registry, imported from source (same approach as the
// SHARED_TOOL_SPECS contract spec) so the tier metadata is checked against
// exactly what @docmost/mcp ships.
import { SHARED_TOOL_SPECS } from '../../../../../../packages/mcp/src/tool-specs';
// For the live-toolset partition test (F3): the REAL adapter, so the catalog is
// checked against the tools AiChatToolsService.forUser() actually builds — not a
// static list that could drift from it.
import { AiChatToolsService } from './ai-chat-tools.service';
import * as loader from './docmost-client.loader';
import type { DocmostClientLike } from './docmost-client.loader';

/**
 * #332 deferred tool loading — tier metadata, catalog assembly, and the
 * loadTools meta-tool. Pure units; no Nest graph, no @docmost/mcp build (the
 * registry is imported from TS source).
 */

describe('tool tier metadata (#332)', () => {
  it('core set is the documented 13 + searchInPage + insertFootnote + getTree + getPageContext (17, #443)', () => {
    expect(CORE_TOOL_KEYS).toHaveLength(17);
    expect(CORE_TOOL_SET.has('searchInPage')).toBe(true); // #330, promoted to core
    expect(CORE_TOOL_SET.has('insertFootnote')).toBe(true); // #410, promoted to core
    expect(CORE_TOOL_SET.has('getTree')).toBe(true); // #443, promoted to core
    expect(CORE_TOOL_SET.has('getPageContext')).toBe(true); // #443, promoted to core
    // loadTools is a meta-tool, not a normal core key.
    expect(CORE_TOOL_SET.has(LOAD_TOOLS_NAME)).toBe(false);
  });

  it('#410 image tools are DEFERRED, footnote tool is CORE', () => {
    // insertFootnote is core (symmetric with editPageText); the image tools stay
    // deferred (rare, fat — loaded on demand). Assert both the spec tier and the
    // CORE_TOOL_SET membership so a future tier edit that desyncs them fails here.
    expect(SHARED_TOOL_SPECS.insertFootnote.tier).toBe('core');
    expect(CORE_TOOL_SET.has('insertFootnote')).toBe(true);
    expect(SHARED_TOOL_SPECS.insertImage.tier).toBe('deferred');
    expect(CORE_TOOL_SET.has('insertImage')).toBe(false);
    expect(SHARED_TOOL_SPECS.replaceImage.tier).toBe('deferred');
    expect(CORE_TOOL_SET.has('replaceImage')).toBe(false);
  });

  it('SHARED_TOOL_SPECS tier agrees with CORE_TOOL_SET for every shared tool', () => {
    for (const [key, spec] of Object.entries(SHARED_TOOL_SPECS)) {
      const isCoreByTier = spec.tier === 'core';
      const isCoreByList = CORE_TOOL_SET.has(key);
      expect(isCoreByTier).toBe(isCoreByList);
      // Every spec carries a non-empty catalogLine (core tools too).
      expect(typeof spec.catalogLine).toBe('string');
      expect(spec.catalogLine.trim().length).toBeGreaterThan(0);
    }
  });

  it('every INLINE tool tier agrees with CORE_TOOL_SET and has a catalogLine', () => {
    for (const [key, meta] of Object.entries(INLINE_TOOL_TIERS)) {
      expect(meta.tier === 'core').toBe(CORE_TOOL_SET.has(key));
      expect(meta.catalogLine.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('buildInAppDeferredCatalog (#332)', () => {
  const catalog = buildInAppDeferredCatalog(SHARED_TOOL_SPECS as never);
  const names = catalog.map((e) => e.name);

  it('includes deferred tools from BOTH the inline map and the shared registry', () => {
    expect(names).toContain('transformPage'); // inline deferred
    expect(names).toContain('getPageJson'); // shared deferred
    expect(names).toContain('patchNode'); // shared deferred
    expect(names).toContain('createPage'); // inline deferred
  });

  it('NEVER lists a core tool', () => {
    for (const core of CORE_TOOL_KEYS) {
      expect(names).not.toContain(core);
    }
    // spot-check a couple that are core in each source.
    expect(names).not.toContain('searchInPage'); // shared core
    expect(names).not.toContain('searchPages'); // inline core
    expect(names).not.toContain('editPageText'); // shared core
  });

  it('renders every entry as a "name — purpose" line', () => {
    // Non-empty catalog (the length is pinned structurally by the live-toolset
    // partition test below, not by a magic constant that rots on every new tool).
    expect(catalog.length).toBeGreaterThan(0);
    for (const entry of catalog) {
      expect(entry.catalogLine).toMatch(/ — /);
    }
  });
});

/**
 * F3 — the deferred <tool_catalog> is built from STATIC metadata (INLINE_TOOL_TIERS
 * + SHARED_TOOL_SPECS), but the loadable-by-name set is derived at RUNTIME from the
 * actual toolset (`Object.keys(baseTools)` in ai-chat.service.ts). Those two must
 * agree or a tool becomes loadable-but-invisible (agent thinks it doesn't exist) or
 * catalogued-but-phantom. INLINE_TOOL_TIERS is a plain hand-maintained Record with
 * no compile-time link to the tools AiChatToolsService.forUser() builds, so nothing
 * else catches that drift. This test uses forUser()'s LIVE keys as the source of
 * truth (mirroring ai-chat-tools.service.spec.ts's loader mock) and asserts a
 * two-way partition against buildInAppDeferredCatalog — replacing the old magic
 * toHaveLength(28), so a tool added to forUser() without a catalog line (or a
 * catalog line without a real tool) fails the suite instead of silently vanishing.
 */
describe('deferred catalog ↔ live forUser() toolset partition (#332, F3)', () => {
  let toolKeys: string[];
  const catalogNames = buildInAppDeferredCatalog(SHARED_TOOL_SPECS as never).map(
    (e) => e.name,
  );

  beforeAll(async () => {
    // Intercept the ESM loader so forUser() builds against the TS-source shared
    // specs (no @docmost/mcp build) and never touches the network.
    jest.spyOn(loader, 'loadDocmostMcp').mockResolvedValue({
      DocmostClient: function () {
        return {} as DocmostClientLike;
      } as unknown as loader.DocmostClientCtor,
      sharedToolSpecs: SHARED_TOOL_SPECS as unknown as Record<string, loader.SharedToolSpec>,
      // Pure no-network draw.io helpers (#424); tool bodies are never executed here.
      searchShapes: (() => []) as unknown as loader.SearchShapesFn,
      getGuideSection: (() => ({
        section: 'index',
        content: '',
        sections: [],
      })) as unknown as loader.GetGuideSectionFn,
    });
    const service = new AiChatToolsService(
      {
        generateAccessToken: jest.fn().mockResolvedValue('access-token'),
        generateCollabToken: jest.fn().mockResolvedValue('collab-token'),
      } as never,
      {} as never, // aiService — not exercised while merely BUILDING the tools
      {} as never, // pageEmbeddingRepo
      {} as never, // spaceMemberRepo
      {} as never, // pagePermissionRepo
      // sandboxStore: forUser() eagerly calls asSink() to wire the stash tool.
      {
        asSink: () => ({ put: jest.fn(), has: jest.fn(), evict: jest.fn() }),
      } as never,
      // #599: EmbeddingGenerationService (active-generation fingerprint for
      // the hybrid RAG read). Unused by this spec (the RAG path falls back).
      {} as never,
      // #629: EnvironmentService (DRAWIO_RASTER_ENABLED mirror). Flag OFF here
      // so viewImage's drawio no-raster path stays inert (resvg fallback).
      { isDrawioRasterEnabled: () => false } as never,
    );
    const tools = await service.forUser(
      { id: 'user-1', email: 'u@example.com', workspaceId: 'ws-1' } as never,
      'session-1',
      'ws-1',
      'chat-1',
    );
    toolKeys = Object.keys(tools);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('exposes a non-trivial toolset (sanity: the mock actually built tools)', () => {
    expect(toolKeys.length).toBeGreaterThan(20);
  });

  it('every non-core live tool is present in the catalog (no capability silently hidden)', () => {
    // forUser() does not itself add loadTools (ai-chat.service does), but guard
    // anyway. Every remaining non-core key MUST have a catalog line.
    const catalogSet = new Set(catalogNames);
    const missing = toolKeys.filter(
      (k) => !CORE_TOOL_SET.has(k) && k !== LOAD_TOOLS_NAME && !catalogSet.has(k),
    );
    expect(missing).toEqual([]);
  });

  it('every catalog entry corresponds to a real, non-core live tool (no phantom)', () => {
    const liveSet = new Set(toolKeys);
    const phantom = catalogNames.filter(
      (n) => !liveSet.has(n) || CORE_TOOL_SET.has(n),
    );
    expect(phantom).toEqual([]);
  });
});

describe('buildExternalToolCatalog + shortenForCatalog (#332)', () => {
  it('derives a short "name — purpose" line from each external tool description', () => {
    const catalog = buildExternalToolCatalog({
      tavily_search: { description: 'Search the web for fresh results. More detail here.' },
      tavily_extract: { description: '' },
    });
    expect(catalog).toEqual([
      { name: 'tavily_search', catalogLine: 'tavily_search — Search the web for fresh results.' },
      { name: 'tavily_extract', catalogLine: 'tavily_extract — external tool' },
    ]);
  });

  it('caps a very long description', () => {
    const long = 'x'.repeat(500);
    expect(shortenForCatalog(long).length).toBeLessThanOrEqual(140);
    expect(shortenForCatalog(long).endsWith('…')).toBe(true);
  });
});

describe('applyLoadTools (#332)', () => {
  const valid = new Set(['createPage', 'transformPage', 'tavily_search']);

  it('adds valid names to the activated set and returns { loaded }', () => {
    const activated = new Set<string>();
    const result = applyLoadTools(['createPage', 'tavily_search'], activated, valid);
    expect(result).toEqual({ loaded: ['createPage', 'tavily_search'] });
    expect(activated.has('createPage')).toBe(true);
    expect(activated.has('tavily_search')).toBe(true);
  });

  it('rejects an unknown name with an error listing the valid deferred names', () => {
    const activated = new Set<string>();
    expect(() => applyLoadTools(['nope'], activated, valid)).toThrow(/unknown tool name/i);
    try {
      applyLoadTools(['nope'], activated, valid);
    } catch (e) {
      const msg = (e as Error).message;
      // Lists every valid name (sorted).
      expect(msg).toContain('createPage');
      expect(msg).toContain('transformPage');
      expect(msg).toContain('tavily_search');
    }
    // Nothing is activated on a rejected call.
    expect(activated.size).toBe(0);
  });

  it('tolerates a non-array / empty input (loads nothing)', () => {
    const activated = new Set<string>();
    expect(applyLoadTools(undefined, activated, valid)).toEqual({ loaded: [] });
    expect(applyLoadTools([], activated, valid)).toEqual({ loaded: [] });
    expect(activated.size).toBe(0);
  });

  it('loadTools description is the verbatim issue text', () => {
    expect(LOAD_TOOLS_DESCRIPTION).toContain('only ACTIVATES them');
    expect(LOAD_TOOLS_DESCRIPTION).toContain('callable on your NEXT step');
  });

  it('loadTools description tells the model CORE tools are always active (#444)', () => {
    expect(LOAD_TOOLS_DESCRIPTION).toContain(
      'Tools NOT listed in the catalog are CORE and ALWAYS active',
    );
    expect(LOAD_TOOLS_DESCRIPTION).toContain('NEVER via loadTools');
    // Names it out explicitly so the model doesn't loadTools a core tool.
    expect(LOAD_TOOLS_DESCRIPTION).toContain('createComment');
    expect(LOAD_TOOLS_DESCRIPTION).toContain('searchInPage');
  });
});

describe('editorial "Corrector" scenario is fully served by CORE (#332)', () => {
  it('read + comment + edit + search need no loadTools', () => {
    // A Corrector role reads a page, searches within it, edits text, and leaves
    // inline comments — every tool it needs is core, so it never has to load a
    // deferred tool.
    const needed = [
      'getCurrentPage',
      'getPage',
      'searchPages',
      'searchInPage',
      'editPageText',
      'createComment',
      'listComments',
      'getComment',
      'resolveComment',
    ];
    for (const t of needed) {
      expect(CORE_TOOL_SET.has(t)).toBe(true);
    }
  });
});
